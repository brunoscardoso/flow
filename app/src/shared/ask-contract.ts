// Ask the Blueprint — the shapes main and the renderer share (plan
// `ask_the_blueprint`, Phase 2).
//
// ONE QUESTION, STREAMED AS STATE, NOT TOKENS. `ask:start` answers an id at
// once; the work continues in main and every change the panel can draw arrives
// on `ask:state` — the phase (fast → digging → done | partial | error) and the
// best answer so far. A state event is sent only when the step list or the
// answer changes (NFR-4), never per streamed activity.
//
// NOTHING FROM A CONVERSATION CROSSES INTO THE SAVED LOG. A tagged
// conversation is context for the answer; the saved entry records only THAT
// one was used. Unmerged work on a tagged conversation's branch is reported as
// `branchInProgress` and is never written as a fact.

// ── Two scopes, one request shape ───────────────────────────────────────────
//
// A request WITHOUT `workspace` is today's project ask of `rootId`, unchanged.
// A request WITH it asks the Workspace `rootId` belongs to: `rootId` stays the
// project the board stands in (the one main resolves the Workspace from), and
// every id names its project — the Workspace tag grammar the saved log speaks:
//
//   feature:<project>::<slug>[/<part>]    a feature (or part) of one project
//   project:<project>                     a whole project
//   link:<a>::<b>                         the connection between two projects (slugs sorted)
//
// Sources carry `project`; a file source's path is relative to that project.

/** The Workspace an ask is about. */
export interface AskWorkspaceScope {
  /** The Workspace's slug, as the Workspace map names it. */
  workspace: string
  /**
   * The in-scope project slugs. Projects named by the tags are added in main;
   * empty (and no tag naming one) = every project of the Workspace.
   */
  projects: string[]
}

/** What the panel asks. `rootId` is the project's absolute path, as on every blueprint channel. */
export interface AskRequest {
  rootId: string
  /** The question as typed or pasted. */
  question: string
  /**
   * Project scope: feature and part ids (`feature:<slug>` / `feature:<slug>/<part>`).
   * Workspace scope: Workspace tags (`feature:<project>::<slug>[/<part>]`, `project:<p>`, `link:<a>::<b>`).
   */
  tags: string[]
  /** The person's own conversations they tagged — read in main, never stored. */
  conversationIds: string[]
  /** The saved entry this question follows up, when it is a follow-up (a `wqa-` id in Workspace scope). */
  followUpOf?: string | null
  /** Present = ask the Workspace; absent or null = the project ask of `rootId`. */
  workspace?: AskWorkspaceScope | null
}

/** `feature:<slug>[/<part>]` of `project` → `feature:<project>::<slug>[/<part>]`; an id already qualified is kept. */
export function qualifyFeatureId(project: string, id: string): string {
  if (!id.startsWith('feature:')) return id
  const rest = id.slice('feature:'.length)
  if (rest.includes('::')) return id
  return `feature:${project}::${rest}`
}

/** Split `feature:<project>::<rest>` into its project and the project-local id; null when it is not qualified. */
export function splitQualifiedFeatureId(id: string): { project: string; localId: string } | null {
  const match = /^feature:([A-Za-z0-9._-]+)::(.+)$/.exec(id)
  if (match === null) return null
  return { project: match[1], localId: `feature:${match[2]}` }
}

/** `ask:start`'s answer: the id state events will carry, or why nothing started. */
export type AskStartResponse = { ok: true; askId: string } | { ok: false; detail: string }

/** One line of the digging card. The last line of a running dig is `current`. */
export interface AskStep {
  label: string
  state: 'done' | 'current'
}

/** Where one question stands. */
export type AskPhase =
  | { kind: 'fast' }
  | { kind: 'digging'; steps: AskStep[]; reads: number; elapsedMs: number }
  | { kind: 'done' }
  | { kind: 'partial' }
  | { kind: 'error'; sentence: string }

/**
 * One source an answer leans on. `n` is its position in the answer's list
 * (1-based) — what the answer's `[n]` citations name; null only on records
 * written before sources were numbered by position.
 */
export interface AskSource {
  n: number | null
  label: string
  /** Workspace scope: qualified (`feature:<project>::<slug>[/<part>]`). */
  featureId?: string
  /** Relative to its project's checkout. Never present for a project not on this computer. */
  file?: string
  /** Workspace scope: the project the source is in. */
  project?: string
}

/** How two projects touch — the Workspace link vocabulary. `from` <kind> `to`. */
export type AskConnectionKind = 'calls' | 'exposes' | 'consumes' | 'relates'

/**
 * A touchpoint between two in-scope projects the answer found and the
 * Workspace has not recorded yet. Shown with "Save as connection"; recorded
 * ONLY when `ask:saveConnection` is called with it — never automatically.
 */
export interface AskSuggestedConnection {
  /** Stable within the answer: `<from>|<kind>|<to>`. */
  id: string
  kind: AskConnectionKind
  fromProject: string
  /** `<project>/<feature-slug>` or `<project>/<anchor-kind>:<ref>` (endpoint, file, module, symbol, table). */
  from: string
  toProject: string
  to: string
  /** One line on how they touch. */
  note?: string
}

/** A short judgement on a "can we build Y?" question. */
export interface AskVerdict {
  label: string
  risk?: string
}

/** The answer the panel shows — the fast one first, the checked one in its place after a dig. */
export interface AskAnswer {
  /** Always present: a malformed return still shows its text. */
  explanation: string
  /** `first` — from what Flow already knows; `checked` — the code was read. */
  confidence: 'first' | 'checked'
  /** The first pass said the knowledge was thin. */
  thin: boolean
  sources: AskSource[]
  verdict?: AskVerdict
  reply?: string
  /** Code facts recorded as anchored notes for this answer. */
  factsLearned: number
  /** False when a fact could not be recorded — the footer says so; the answer stands. */
  factsSaved: boolean
  /** The saved entry's id, once the answer is in the log. */
  savedId?: string
  /** "in progress on branch X (not merged)" — unmerged work is context, never a fact. */
  branchInProgress?: string
  /** The code check did not finish (Stop here, or the budget ran out). */
  partial: boolean
  /** What the dig could not find, in one sentence, when it says so. */
  couldNotFind?: string
  /** Workspace scope: in-scope projects whose code the dig read. */
  projectsRead?: string[]
  /** Workspace scope: in-scope projects answered from shared knowledge only (not on this computer, or not open in Flow). */
  knowledgeOnly?: string[]
  /** Workspace scope: touchpoints between in-scope projects not yet recorded. */
  suggestedConnections?: AskSuggestedConnection[]
}

/** The one event: a question's phase and its best answer so far. */
export interface AskStateEvent {
  askId: string
  rootId: string
  /** The Workspace slug when the ask is Workspace-scoped; null for a project ask. */
  workspace?: string | null
  phase: AskPhase
  answer: AskAnswer | null
}

/** `ask:stop` — Stop here. `stopped` is false when no such ask is running. */
export interface AskStopResponse {
  stopped: boolean
}

// ── The saved log, as the panel reads it ────────────────────────────────────

/** One saved answer or follow-up (mirror of the CLI's QaEntry, minus hash stamps). */
export interface AskSavedEntry {
  id: string
  ts: string
  author: string
  question: string
  tags: string[]
  conversationCount: number
  usedConversation: boolean
  answer: string
  verdict?: AskVerdict
  reply?: string
  sources: Array<{ label: string; featureId?: string; file?: string; project?: string }>
  factsLearned: number
  parentId?: string
  partial: boolean
  branchInProgress?: string
  /** A Workspace answer: its Workspace's slug. */
  workspace?: string
  /** A Workspace answer: the local projects whose code was read. */
  projectsRead?: string[]
  /** A Workspace answer: the projects answered from shared knowledge only. */
  knowledgeOnly?: string[]
  /** A Workspace answer: every project it names. */
  cited?: string[]
  /**
   * In a project's own list: this entry is a pointer to a Workspace answer
   * (its `answer` is empty) — the rest is read from the Workspace.
   */
  workspaceAnswer?: { workspace: string; entryId: string }
}

/** A saved answer with its follow-ups, oldest first. */
export interface AskSavedThread extends AskSavedEntry {
  followUps: AskSavedEntry[]
}

/** The saved Workspace answers to read: the Workspace, narrowed by Workspace tags (none = all of it). */
export interface AskWorkspaceListScope {
  workspace: string
  /** `feature:<project>::<slug>[/<part>]`, `project:<p>`, `link:<a>::<b>`. Empty = the whole Workspace. */
  tags: string[]
}

/** `ask:list` request: the features (or parts) whose saved answers to read. */
export interface AskListRequest {
  rootId: string
  /** Project scope. Ignored in Workspace scope. */
  featureIds: string[]
  /**
   * Project scope: every saved question of the project in ONE read, whatever
   * `featureIds` says — the board's per-feature markers, read once per load.
   */
  all?: boolean
  /** Present = the Workspace's saved answers; absent or null = the project's. */
  workspace?: AskWorkspaceListScope | null
}

export type AskListResponse = { ok: true; threads: AskSavedThread[] } | { ok: false; detail: string }

/** `ask:stale` request: every saved answer, or those of one feature. */
export interface AskStaleRequest {
  rootId: string
  /** Project scope. Ignored in Workspace scope. */
  featureId?: string
  /** Present = the Workspace's saved answers for these tags; absent or null = the project's. */
  workspace?: AskWorkspaceListScope | null
}

/** Whether the code under one saved entry changed since it was written. */
export interface AskStaleResult {
  id: string
  stale: boolean
  /** Workspace scope: written `<project>/<path>`. */
  changedFiles: string[]
  missingFiles: string[]
  /** Workspace scope: projects whose cited files could not be checked here — never counted as fresh. */
  notChecked?: string[]
}

export type AskStaleResponse = { ok: true; results: AskStaleResult[] } | { ok: false; detail: string }

/** `ask:saveConnection` — "Save as connection" on a suggested connection. */
export interface AskSaveConnectionRequest {
  rootId: string
  /** The Workspace's slug. */
  workspace: string
  connection: AskSuggestedConnection
}

/** `recorded: false` — the same connection was already there; nothing new was written. */
export type AskSaveConnectionResponse = { ok: true; recorded: boolean } | { ok: false; detail: string }

// ── Opening the panel from anywhere in the app ──────────────────────────────

/**
 * THE ONE DOOR. Every opener of the Ask panel — the board's own Ask button and
 * shortcut, and Phase 4's "Ask about this", palette command and chat message
 * action — dispatches this event on `document`. The Blueprint wiring opens the
 * board's tab and hands the detail to the panel; no opener reaches into the
 * board directly, so there is one place that decides what opening means.
 *
 *   document.dispatchEvent(new CustomEvent(ASK_BLUEPRINT_EVENT, { detail }))
 */
export const ASK_BLUEPRINT_EVENT = 'flow:ask-blueprint'

/** A tag an opener passes: a feature, a part, or one of the person's conversations. */
export interface AskOpenTag {
  /** `feature:<slug>`, `feature:<slug>/<part>` (qualified on the Workspace sheet), or a thread id for a conversation. */
  id: string
  kind: 'feature' | 'part' | 'conversation'
  /** What the chip says. Falls back to the id's own name when absent. */
  label?: string
  /** The project the feature or part is in, when it was tagged on the Workspace sheet. */
  project?: string
}

/**
 * `flow:ask-blueprint`'s detail. Every field is optional: no detail opens the
 * panel where it was left; any field starts a fresh question with it.
 */
export interface AskBlueprintOpenDetail {
  /** Text to put in the question box (a pasted message, a palette query). */
  text?: string
  /** Tags to start with. */
  tags?: AskOpenTag[]
  /** A conversation to tag — the chat message action's own thread. */
  threadId?: string
  /** That conversation's title, for its chip. */
  threadTitle?: string
  /** `history` opens straight to the saved list for `tags` (See all). */
  view?: 'history'
  /** A saved answer to show — opens the panel on it, in place of a fresh question. */
  entryId?: string
  /** Ask the text now instead of leaving it in the box (Ask again). */
  submit?: boolean
  /**
   * Ask the Workspace rather than the project — set by a Workspace answer's
   * pointer on a project's brief, so its entry opens where it was saved.
   */
  workspace?: boolean
}

/** Read an untrusted event detail into the shape above; anything malformed is dropped, never thrown. */
export function parseAskOpenDetail(detail: unknown): AskBlueprintOpenDetail {
  if (typeof detail !== 'object' || detail === null) return {}
  const raw = detail as Record<string, unknown>
  const out: AskBlueprintOpenDetail = {}
  if (typeof raw['text'] === 'string' && raw['text'].trim() !== '') out.text = raw['text']
  if (typeof raw['threadId'] === 'string' && raw['threadId'] !== '') out.threadId = raw['threadId']
  if (typeof raw['threadTitle'] === 'string' && raw['threadTitle'] !== '') out.threadTitle = raw['threadTitle']
  if (raw['view'] === 'history') out.view = 'history'
  if (typeof raw['entryId'] === 'string' && raw['entryId'] !== '') out.entryId = raw['entryId']
  if (raw['submit'] === true) out.submit = true
  if (raw['workspace'] === true) out.workspace = true
  if (Array.isArray(raw['tags'])) {
    const tags: AskOpenTag[] = []
    for (const item of raw['tags']) {
      if (typeof item !== 'object' || item === null) continue
      const tag = item as Record<string, unknown>
      const kind = tag['kind']
      if (typeof tag['id'] !== 'string' || tag['id'] === '') continue
      if (kind !== 'feature' && kind !== 'part' && kind !== 'conversation') continue
      tags.push({
        id: tag['id'],
        kind,
        ...(typeof tag['label'] === 'string' && tag['label'] !== '' ? { label: tag['label'] } : {}),
        ...(typeof tag['project'] === 'string' && tag['project'] !== '' ? { project: tag['project'] } : {}),
      })
    }
    if (tags.length > 0) out.tags = tags
  }
  return out
}
