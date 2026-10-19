/**
 * WORKSPACES — the shapes main and the renderer share.
 *
 * A Workspace groups projects and owns their knowledge. Its structure lives on
 * disk and belongs to the CLI (`planflow-ai workspace …`, the source of truth):
 * the app never derives a Workspace path or a membership itself — main's
 * registry asks the CLI, and these are the answers it hands on.
 *
 * Every answer is a value or a typed refusal. A refusal's `detail` is a
 * sentence a person can read (no commands, paths or setting names —
 * forbidden-pattern #12); its `payload` carries what the asking surface needs
 * to put the question (allowed-pattern #21) — the choices, the commit a
 * committed `flow/` would take, and so on.
 */

/** Every reason the CLI's `workspace` verbs refuse with (src/cli/handlers/workspace-model.ts). */
export const WORKSPACE_CLI_REFUSALS = [
  'invalid-name',
  'invalid-remote',
  'insecure-remote',
  'credentials-in-url',
  'no-workspace',
  'which-workspace',
  'unknown-workspace',
  'unknown-project',
  'not-a-git-repo',
  'unreadable-remote',
  'committed-flow',
  'dirty-code',
  'keeps-own-knowledge-repo',
  'linked-elsewhere',
  'malformed-workspace',
  'not-a-workspace-repo',
  'malformed-local-map',
  'already-joined',
  'clone-failed',
  'commit-failed',
  'invalid-description',
  'sync-busy',
  'invalid-roots',
  'duplicate-name',
  'same-workspace',
  'project-exists',
  'default-workspace',
  'unconfirmed',
  'remote-exists',
  'merge-in-progress',
  'failed',
] as const

export type WorkspaceCliRefusal = (typeof WORKSPACE_CLI_REFUSALS)[number]

/**
 * The refusal the app adds: `unavailable` (the CLI answered nothing usable:
 * too old, timed out, crashed).
 */
export type WorkspaceRefusalReason = WorkspaceCliRefusal | 'unavailable'

export interface WorkspaceRefusal {
  ok: false
  reason: WorkspaceRefusalReason
  /** A sentence for a person. */
  detail: string
  /** The CLI's structured payload, minus `action` / `refused` / `detail`. Empty when there is none. */
  payload: Record<string, unknown>
}

export type WorkspaceAnswer<T> = ({ ok: true } & T) | WorkspaceRefusal

export interface WorkspaceSummary {
  name: string
  /** The Workspace's folder name on this machine — its handle everywhere in the app. */
  slug: string
  path: string
  remote: string | null
  /**
   * The Default Workspace — the one every project lands in unless a person
   * moves it, and the one that can't be deleted. A local notion (the CLI's
   * `default: true`); false when the CLI does not say.
   */
  isDefault: boolean
}

export interface WorkspaceProject {
  /** The remote identity (`host/owner/repo`), or `local:<slug>` for a repo with no remote. */
  id: string
  name: string
  slug: string
  remotes: string[]
  description: string | null
  /** This machine's checkout — the project root — or null when none is known here. */
  localPath: string | null
  /** The project's knowledge folder (what `<repo>/flow` links to). */
  flowPath: string
}

export interface WorkspaceListing extends WorkspaceSummary {
  projects: WorkspaceProject[]
}

export interface WorkspacesList {
  /** The Flow folder, as the CLI resolves it — the app never resolves it itself. */
  flowFolder: string
  workspaces: WorkspaceListing[]
  /** Folders that are not readable Workspaces — reported, never fatal. */
  unreadable: Array<{ workspace: string; detail: string }>
}

/** Which Workspace and project a repo is (the CLI's `workspace status --target`). */
export interface WorkspaceMembership {
  flowFolder: string
  target: string
  /** Null when the repo is in no Workspace — not an error. */
  workspace: WorkspaceSummary | null
  project: WorkspaceProject | null
  /** Whether `<repo>/flow` already links to the project's folder. */
  linked: boolean
  via: 'flow-link' | 'local-path' | 'remote' | null
  siblings: WorkspaceProject[]
  alsoIn: string[]
}

/**
 * The Workspace each root belongs to (by this machine's checkouts), or null —
 * THE one membership answer every app surface reads (the renderer never
 * re-derives it from paths). `project` is the Workspace project's id;
 * `linked` says whether `<root>/flow` already resolves into that project's
 * folder (the CLI's `flowPath`).
 */
export interface WorkspaceRootMembership {
  roots: Array<{ root: string; workspace: string | null; project: string | null; linked: boolean }>
}

/**
 * FR-3's auto-suggest: an opened repo that a local Workspace lists (by its
 * remote, or by this machine's record of its folder) but whose knowledge is
 * not linked there yet. `none` is every other case.
 */
export type WorkspaceSuggestion =
  | { kind: 'none' }
  | { kind: 'link'; workspace: WorkspaceSummary; project: WorkspaceProject; via: 'local-path' | 'remote' }

/** What `<repo>/flow` was before a link, and where it is now. Nothing is ever deleted. */
export type WorkspacePreviousFlow =
  | { kind: 'none' }
  | { kind: 'workspace-link' }
  | { kind: 'link' }
  | { kind: 'folder'; keptAt: string }
  | { kind: 'committed-folder'; keptAt: string }

export interface WorkspaceLinkResult {
  workspace: WorkspaceSummary
  project: WorkspaceProject
  link: 'created' | 'unchanged'
  previous: WorkspacePreviousFlow
  projectAdded: boolean
  /** The one code-repo commit a committed `flow/` took, when it took one. */
  commit: { sha: string; message: string; files: number } | null
}

export interface WorkspaceJoinResult {
  workspace: WorkspaceSummary
  linked: WorkspaceProject[]
  noLocalCheckout: WorkspaceProject[]
  /** Projects whose checkout needs a person first; `refusal` is the CLI's payload for it. */
  needsReview: Array<WorkspaceProject & { refusal: Record<string, unknown> }>
  /**
   * The CLI's remote-only matches: a checkout this machine knows (its
   * `localPath`) whose remote matches a project. NEVER linked by the join.
   */
  candidates: WorkspaceProject[]
  /**
   * The projects OPEN in Flow that look like one of the joined Workspace's —
   * by remote, which a Workspace file can name for any repository. Proposed
   * only: the Join dialog shows them unticked, and nothing is linked until the
   * person presses "Add these projects" (an ordinary `workspaces:link` each).
   */
  openCandidates: Array<{ root: string; project: WorkspaceProject }>
}

export type WorkspacesChangeCause =
  | 'created'
  | 'linked'
  | 'joined'
  | 'current'
  | 'task-projects'
  | 'described'
  | 'migrated'
  | 'renamed'
  | 'moved'
  | 'deleted'
  | 'placement'
  /** A Workspace was connected to, or disconnected from, a shared repository. */
  | 'remote'

export interface WorkspacesChangedEvent {
  cause: WorkspacesChangeCause
}

// ── Every project in a Workspace: the migration and placing a new project ──

/** What `<repo>/flow` held before it moved in, and how much of it came along. */
export interface WorkspaceImported {
  files: number
  skipped: number
  renamed: number
}

/** The one code-repo commit a committed knowledge folder takes — shown before it is made. */
export interface WorkspacePendingCommit {
  message: string
  files: number
  from: string
  to: string
}

/** The CLI's `workspace migrate` answer, rebuilt field by field. */
export interface WorkspaceMigrateResult {
  dryRun: boolean
  workspace: WorkspaceSummary & { created: boolean }
  migrated: Array<{ root: string; project: WorkspaceProject; previous: WorkspacePreviousFlow; imported: WorkspaceImported | null }>
  unchanged: string[]
  pending: Array<{ root: string; reason: 'committed-folder'; commit: WorkspacePendingCommit }>
  failed: Array<{ root: string; reason: string; detail: string }>
}

/**
 * A project that is not in a Workspace yet, and why — what the switcher's
 * "Needs attention" rows draw. `root` is data (the button's target), never
 * shown as text; `name` is the folder's name.
 */
export type WorkspacePlacementIssue =
  | {
      kind: 'pending'
      root: string
      name: string
      /** The Workspace it is waiting to move into. */
      workspace: string
      workspaceName: string
      commit: WorkspacePendingCommit
      /** Why the last "Move it in" did not finish, as a plain sentence — null until one failed. */
      problem: string | null
    }
  | {
      kind: 'failed'
      root: string
      name: string
      /** A plain sentence (no paths, commands or setting names). */
      reason: string
    }

/** `workspaces:placement` — the projects outside every Workspace, and why. */
export interface WorkspacePlacementState {
  /** True until the first launch's migration has run (or found nothing to do). */
  migrating: boolean
  issues: WorkspacePlacementIssue[]
}

/** The answer to a delete asked without confirmation: what would move to Default. */
export interface WorkspaceDeleteResult {
  workspace: string
  /** The projects that moved into Default. */
  moved: string[]
}

// ── A thread's projects, chosen from its messages (the context gate) ────────

/** One project a thread's context gained or could gain. `root` is data, never shown as text. */
export interface ThreadContextProject {
  /** The project's checkout on this machine — what the thread attaches. */
  root: string
  /** The project's name, as the Workspace calls it. */
  name: string
}

/**
 * `threads:contextChosen` — the first message of a Workspace thread added
 * these projects before its session started. Rendered as removable chips;
 * removing one is the ordinary detach.
 */
export interface ThreadContextChosenEvent {
  threadId: string
  added: ThreadContextProject[]
  source: 'gate'
}

/**
 * `threads:contextOffer` — a later message looks like it needs another project
 * of the Workspace. An OFFER only: nothing is attached until the person accepts
 * (the ordinary attach). `reason` is one plain sentence.
 */
export interface ThreadContextOfferEvent {
  threadId: string
  project: ThreadContextProject
  reason: string
}

// ── Workspace sync — one git sync per Workspace (Phase 8) ──────────────────

/**
 * Where a Workspace's sync stands, for the UI.
 *
 *  · `idle` — nothing has run this session (or a retry is due shortly);
 *  · `syncing` — the CLI's `workspace sync` is running;
 *  · `synced` — everything here is in the shared repository and its changes are here;
 *  · `paused` — a person must decide (`asks`) or settle a merged version (`reviews`);
 *    nothing retries on its own while paused;
 *  · `offline` — the shared repository could not be reached; a retry is scheduled;
 *  · `error` — sync can't run as things are (`detail` says why);
 *  · `local-only` — the Workspace has no shared repository; changes stay here;
 *  · `no-access` — the shared repository refused this person's access; changes
 *    stay here, nothing retries on its own ("Sync now" tries again).
 */
export type WorkspaceSyncState = 'idle' | 'syncing' | 'synced' | 'paused' | 'offline' | 'no-access' | 'error' | 'local-only'

/** How one ask or review may be settled (the CLI's `--take`); `file` means "this text" — the app sends `text`. */
export type WorkspaceSyncTake = 'ours' | 'theirs' | 'merged' | 'file'

/** A same-topic collision or a decision both sides changed: a person chooses. */
export interface WorkspaceSyncAsk {
  /** Stable for exactly this content on both sides. */
  id: string
  kind: 'decision' | 'same-feature' | 'overlapping-anchors' | 'same-discovery'
  /** What the collision is about, in the Workspace's own words. */
  topic: string
  /** The Workspace-relative file the decision is about — data for `resolve`, never shown as text. */
  path: string
  /** Where the Workspace's side lives (the same path, or the other file of a cross-file collision). */
  existingPath: string
  /** What the Workspace already says. */
  existing: string | null
  /** This computer's version. */
  incoming: string | null
  /** Git's clean merge of the two, when there is one. */
  merged: string | null
  anchors?: string[]
  truncated: boolean
  options: WorkspaceSyncTake[]
}

/** A file both sides changed that needs a merged version (an agent may draft it). */
export interface WorkspaceSyncReview {
  id: string
  kind: 'conflict' | 'add-add' | 'modify-delete'
  path: string
  base: string | null
  existing: string | null
  incoming: string | null
  /** The working copy with conflict lines, when there is one. */
  conflicted: string | null
  truncated: boolean
  options: WorkspaceSyncTake[]
}

/** `workspaces:syncStatus` — one Workspace's sync, built field by field in main. */
export interface WorkspaceSyncStatus {
  state: WorkspaceSyncState
  /** ISO time of the last complete sync — kept across restarts — or null. */
  lastSyncedAt: string | null
  /** One plain sentence when there is something to say (no paths, commands or setting names). */
  detail: string | null
  /** `paused` only: what needs a person's choice. */
  asks: WorkspaceSyncAsk[]
  /** `paused` only: what needs a merged version. */
  reviews: WorkspaceSyncReview[]
}

/** `workspaces:syncChanged` — sent only when a Workspace's status actually changed. */
export interface WorkspaceSyncChangedEvent {
  slug: string
  status: WorkspaceSyncStatus
}

/**
 * `workspaces:resolve` — settle one paused item. `take: 'text'` sends the
 * merged text itself (main hands it to the CLI); a file path is never accepted
 * from the renderer.
 */
/**
 * `id` is the ask's or review's own id from the status the person was shown:
 * the CLI decides exactly that item, and refuses (`stale`) when the content
 * changed since. `path` is the item's file, kept for the CLI and older callers.
 */
export type WorkspaceResolveRequest =
  | { slug: string; id?: string; path: string; take: 'ours' | 'theirs' | 'merged' }
  | { slug: string; id?: string; path: string; take: 'text'; text: string }

/** `stale`: the item changed since the person looked — the status carries what is waiting now. */
export type WorkspaceResolveRefusal = 'unknown-workspace' | 'not-waiting' | 'invalid-take' | 'stale' | 'failed'

export type WorkspaceResolveResult =
  | { ok: true; status: WorkspaceSyncStatus }
  | { ok: false; reason: WorkspaceResolveRefusal; detail: string; status: WorkspaceSyncStatus }

// ── Connecting a Workspace to a shared repository ───────────────────────────

/** Where Flow can CREATE a repository: the hosts whose own tool this computer is signed in to. */
export type WorkspaceHostProvider = 'github' | 'azure'

/**
 * `workspaces:hostTools` — which hosts can create a repository from here, and
 * where. Anything else (GitLab, Bitbucket, a server of the team's own) is
 * connected to by its address, never created.
 */
export interface WorkspaceHostTools {
  github: {
    /** The GitHub tool is installed and signed in. */
    available: boolean
    login?: string
    /** The signed-in account first, then its organizations. */
    owners: Array<{ login: string; type: 'user' | 'org' }>
  }
  azure: {
    /** The Azure tool with its DevOps extension is installed and signed in. */
    available: boolean
    organizations: Array<{ name: string; projects: string[] }>
    /** A sentence when there is nothing to choose from, saying why. */
    detail?: string
  }
}

/** `workspaces:createRemote` — make a PRIVATE repository on a signed-in host, then connect the Workspace to it. */
export type WorkspaceCreateRemoteRequest =
  | { slug: string; provider: 'github'; owner: string; name: string; replace?: boolean }
  | { slug: string; provider: 'azure'; organization: string; project: string; name: string; replace?: boolean }

/**
 * `workspaces:setRemote` — connect a Workspace to an existing repository on any
 * git host. `replace: true` only when a person chose to change the one it has.
 */
export interface WorkspaceSetRemoteRequest {
  slug: string
  remote: string
  replace?: boolean
}

/** Why connecting or disconnecting did not happen. */
export type WorkspaceRemoteRefusal =
  | WorkspaceRefusalReason
  | 'invalid-request'
  | 'tool-missing'
  | 'not-signed-in'
  | 'name-taken'
  | 'no-permission'
  | 'timed-out'

/**
 * The answer to connect / create / disconnect. On success `remote` is the
 * address the Workspace now shares through (null after a disconnect) and
 * `status` is the sync that ran right after it. A refusal's `detail` is a plain
 * sentence; `suggestion` a free repository name to offer; `created` the
 * address of a repository that WAS created but could not be connected — the
 * person can still connect to it by its address.
 */
export type WorkspaceRemoteResult =
  | { ok: true; remote: string | null; status: WorkspaceSyncStatus }
  | { ok: false; reason: WorkspaceRemoteRefusal; detail: string; suggestion?: string; created?: string }
