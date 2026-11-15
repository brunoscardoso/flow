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

/** What the panel asks. `rootId` is the project's absolute path, as on every blueprint channel. */
export interface AskRequest {
  rootId: string
  /** The question as typed or pasted. */
  question: string
  /** Feature and part ids (`feature:<slug>` / `feature:<slug>/<part>`) the person tagged. */
  tags: string[]
  /** The person's own conversations they tagged — read in main, never stored. */
  conversationIds: string[]
  /** The saved entry this question follows up, when it is a follow-up. */
  followUpOf?: string | null
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

/** One source an answer leans on. `n` is its number on the map, present only when it resolved to a feature or part. */
export interface AskSource {
  n: number | null
  label: string
  featureId?: string
  file?: string
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
}

/** The one event: a question's phase and its best answer so far. */
export interface AskStateEvent {
  askId: string
  rootId: string
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
  sources: Array<{ label: string; featureId?: string; file?: string }>
  factsLearned: number
  parentId?: string
  partial: boolean
  branchInProgress?: string
}

/** A saved answer with its follow-ups, oldest first. */
export interface AskSavedThread extends AskSavedEntry {
  followUps: AskSavedEntry[]
}

/** `ask:list` request: the features (or parts) whose saved answers to read. */
export interface AskListRequest {
  rootId: string
  featureIds: string[]
}

export type AskListResponse = { ok: true; threads: AskSavedThread[] } | { ok: false; detail: string }

/** `ask:stale` request: every saved answer, or those of one feature. */
export interface AskStaleRequest {
  rootId: string
  featureId?: string
}

/** Whether the code under one saved entry changed since it was written. */
export interface AskStaleResult {
  id: string
  stale: boolean
  changedFiles: string[]
  missingFiles: string[]
}

export type AskStaleResponse = { ok: true; results: AskStaleResult[] } | { ok: false; detail: string }
