/**
 * THE SAME-TOPIC COLLISION CARD — every word it says and every choice it
 * offers, DOM-free (the view is `collision-card.ts`).
 *
 * A paused Workspace sync carries two kinds of waiting item:
 *  · an ASK — a decision both sides changed, or two notes about the same
 *    topic. Decisions are always asked; Flow never settles one on its own.
 *  · a REVIEW — a note both sides changed that needs one merged text.
 * Both get the same choices, read off the item's own `options`:
 *  · "Keep mine" (ours) · "Keep the Workspace's" (theirs)
 *  · "Use the merged version" — only when git produced one
 *  · "Let Flow adapt it" — an agent drafts a merged text in a new thread of
 *    that Workspace; nothing is settled until the person confirms the draft
 *    (then `take: 'text'`)
 *  · "Record a change" — keep the Workspace's, then open a new thread to write
 *    what changed as a new decision.
 *
 * "Existing" is what the Workspace already says (theirs); "incoming" is this
 * computer's (ours) — the CLI's own words.
 *
 * The agent prompts below are messages a person sends into a thread, not
 * screen copy; they still stay plain (no commands, paths or keys), and the
 * draft is read back between two marker lines rather than a fenced block.
 */
import type {
  WorkspaceSyncAsk,
  WorkspaceSyncReview,
  WorkspaceSyncStatus,
  WorkspaceSyncTake,
} from '../../shared/workspaces-contract'
import { comparablePath } from './workspace-switcher-model'

/** The event a paused Workspace's notification (and its settings) dispatch; `detail.slug` is optional. */
export const WORKSPACE_SYNC_EVENT = 'flow:open-workspace-sync'

export const COLLISION_TITLE = 'Workspace sync is paused'
export const NOTHING_WAITING = 'Nothing is waiting — this Workspace’s sync is not paused.'
export const ALL_SETTLED = 'All settled. The Workspace syncs again on its own.'
export const READ_FAILED = 'Flow could not read what is waiting right now. Try again in a moment.'
export const CLOSE_LABEL = 'Close'
export const EXISTING_HEADING = 'What the Workspace already says'
export const INCOMING_HEADING = 'This computer’s version'
export const MERGED_HEADING = 'The merged version'
export const CONFLICTED_HEADING = 'Both versions, side by side in one note'
export const EMPTY_SIDE = 'Nothing — removed on this side'
export const TRUNCATED_LINE = 'Shown in part — the full text is longer.'
export const RESOLVE_FAILED = 'That choice did not save. Try again.'
export const SAVING_LABEL = 'Saving…'

export const KEEP_MINE = 'Keep mine'
export const KEEP_THEIRS = 'Keep the Workspace’s'
export const USE_MERGED = 'Use the merged version'
export const LET_FLOW_ADAPT = 'Let Flow adapt it'
export const RECORD_CHANGE = 'Record a change'

export const ADAPT_STARTED = 'Flow is drafting a merged version in a new conversation. Bring it here when it is ready.'
export const USE_DRAFT_LABEL = 'Bring in Flow’s draft'
export const NO_DRAFT_YET = 'No draft yet — Flow is still writing it.'
export const DRAFT_HEADING = 'The draft — edit it if you like, then use it'
export const USE_THIS_VERSION = 'Use this version'
export const DISCARD_DRAFT = 'Discard the draft'
export const EMPTY_DRAFT = 'The draft is empty. Write the version to keep, or choose another option.'
export const NO_PROJECT_FOR_AGENT = 'Open one of this Workspace’s projects in Flow to let an agent help here.'
export const THREAD_FAILED = 'Flow could not start the conversation. Try again in a moment.'
export const RECORDED_LINE = 'Kept the Workspace’s version. A new conversation is open to record what changed.'

export const DRAFT_BEGIN = 'BEGIN MERGED TEXT'
export const DRAFT_END = 'END MERGED TEXT'

export type CollisionChoice = 'ours' | 'theirs' | 'merged' | 'adapt' | 'record'

export interface ChoiceView {
  choice: CollisionChoice
  label: string
  /** Needs a project open in the Workspace (the agent runs there). */
  needsThread: boolean
}

export interface CollisionItemView {
  /** Stable for this content on both sides — the card's memory key. */
  id: string
  /** For `resolve` — never shown. */
  path: string
  isDecision: boolean
  heading: string
  /** The topic, in the Workspace's own words (data). */
  topic: string
  sides: Array<{ heading: string; text: string }>
  truncated: boolean
  choices: ChoiceView[]
  /** What the agent and the person compare. */
  existing: string | null
  incoming: string | null
  merged: string | null
}

const ASK_HEADINGS: Record<WorkspaceSyncAsk['kind'], string> = {
  decision: 'A decision changed on both sides',
  'same-feature': 'Two versions of the same feature',
  'overlapping-anchors': 'Two notes about the same code',
  'same-discovery': 'Two discoveries of the same thing',
}

const REVIEW_HEADINGS: Record<WorkspaceSyncReview['kind'], string> = {
  conflict: 'A note changed on both sides',
  'add-add': 'The same note was written on both sides',
  'modify-delete': 'A note was changed on one side and removed on the other',
}

/** `decisions/auth-flow.md` → `auth-flow` — a note's name, never its location. */
export function noteTopic(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  const last = parts[parts.length - 1] ?? ''
  const dot = last.indexOf('.')
  const stem = dot > 0 ? last.slice(0, dot) : last
  return stem === '' ? 'A note' : stem
}

/** Folder names that say WHAT KIND a note is, not what it is about. */
const KIND_SEGMENTS = new Set([
  'projects',
  'brain',
  'decisions',
  'features',
  'errors',
  'discovery',
  'plans',
  'brainstorms',
  'contracts',
  'archive',
  'flow',
])

function words(stem: string): string {
  return stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * A topic as a person reads it. The CLI names a collision in the Workspace's
 * own addressing — `backend/decisions/flag-rollout`, `backend/auth`,
 * `backend: src/a.ts, …` — which is a location, not a subject. The card says
 * "flag rollout in backend": the note's name in words, and the project it is
 * in. A topic that is already words is left alone.
 */
export function humanTopic(raw: string): string {
  const topic = raw.trim()
  // `<project>: <anchors>` — two notes about the same code.
  const anchors = /^([^\s/:]+):\s/.exec(topic)
  if (anchors !== null) return `the same code in ${anchors[1]}`
  // `<project>/discovery <slug>` — two discoveries of the same thing.
  const discovery = /^([^\s/]+)\/discovery\s+(\S+)$/.exec(topic)
  if (discovery !== null) return `${words(discovery[2] ?? '')} in ${discovery[1]}`
  if (!topic.includes('/') && !topic.includes('\\')) return topic
  const parts = topic.split(/[\\/]/).filter((part) => part !== '')
  const last = parts.pop() ?? ''
  const dot = last.indexOf('.')
  const name = words(dot > 0 ? last.slice(0, dot) : last)
  const project = parts.find((part) => !KIND_SEGMENTS.has(part))
  if (name === '') return project === undefined ? 'A note' : `a note in ${project}`
  return project === undefined ? name : `${name} in ${project}`
}

function side(heading: string, text: string | null): { heading: string; text: string } {
  return { heading, text: text ?? EMPTY_SIDE }
}

/** The choices an item offers, in the card's order, read off its own options. */
export function choicesFor(options: readonly WorkspaceSyncTake[], merged: string | null): ChoiceView[] {
  const has = (take: WorkspaceSyncTake): boolean => options.includes(take)
  const out: ChoiceView[] = []
  if (has('ours')) out.push({ choice: 'ours', label: KEEP_MINE, needsThread: false })
  if (has('theirs')) out.push({ choice: 'theirs', label: KEEP_THEIRS, needsThread: false })
  if (has('merged') && merged !== null) out.push({ choice: 'merged', label: USE_MERGED, needsThread: false })
  if (has('file')) out.push({ choice: 'adapt', label: LET_FLOW_ADAPT, needsThread: true })
  if (has('theirs')) out.push({ choice: 'record', label: RECORD_CHANGE, needsThread: true })
  return out
}

export function askView(ask: WorkspaceSyncAsk): CollisionItemView {
  const sides = [side(EXISTING_HEADING, ask.existing), side(INCOMING_HEADING, ask.incoming)]
  if (ask.merged !== null) sides.push(side(MERGED_HEADING, ask.merged))
  return {
    id: ask.id,
    path: ask.path,
    isDecision: ask.kind === 'decision',
    heading: ASK_HEADINGS[ask.kind] ?? ASK_HEADINGS['same-feature'],
    topic: humanTopic(ask.topic.trim() === '' ? ask.path : ask.topic),
    sides,
    truncated: ask.truncated,
    choices: choicesFor(ask.options, ask.merged),
    existing: ask.existing,
    incoming: ask.incoming,
    merged: ask.merged,
  }
}

export function reviewView(review: WorkspaceSyncReview): CollisionItemView {
  const sides = [side(EXISTING_HEADING, review.existing), side(INCOMING_HEADING, review.incoming)]
  if (review.conflicted !== null) sides.push({ heading: CONFLICTED_HEADING, text: review.conflicted })
  return {
    id: review.id,
    path: review.path,
    isDecision: false,
    heading: REVIEW_HEADINGS[review.kind] ?? REVIEW_HEADINGS.conflict,
    topic: humanTopic(review.path),
    sides,
    truncated: review.truncated,
    // A review has no clean merge of its own — the conflicted copy is not one.
    choices: choicesFor(review.options, null),
    existing: review.existing,
    incoming: review.incoming,
    merged: null,
  }
}

/** Every waiting item, decisions first — they are always asked. */
export function collisionItems(status: WorkspaceSyncStatus | null): CollisionItemView[] {
  if (status === null || status.state !== 'paused') return []
  const asks = status.asks.map(askView)
  const decisions = asks.filter((item) => item.isDecision)
  const others = asks.filter((item) => !item.isDecision)
  return [...decisions, ...others, ...status.reviews.map(reviewView)]
}

export function introLine(workspaceName: string, count: number): string {
  if (count === 1) return `${workspaceName} needs you to choose one thing before it syncs again.`
  return `${workspaceName} needs you to choose ${count} things before it syncs again.`
}

/** The `take` a plain choice resolves with; the two thread choices are not plain. */
export function takeOf(choice: CollisionChoice): 'ours' | 'theirs' | 'merged' | null {
  if (choice === 'ours' || choice === 'theirs' || choice === 'merged') return choice
  return null
}

// ── The two conversations ───────────────────────────────────────────────────

export function adaptThreadTitle(topic: string): string {
  return `Merge two versions of ${topic}`
}

export function recordThreadTitle(topic: string): string {
  return `Record a change to ${topic}`
}

/** What "Let Flow adapt it" sends: both versions, and how to hand the draft back. */
export function adaptPrompt(input: { workspaceName: string; item: CollisionItemView }): string {
  const { item } = input
  return [
    `The ${input.workspaceName} Workspace has two versions of "${item.topic}" and I need one.`,
    '',
    'What the Workspace already says:',
    item.existing ?? '(nothing — it was removed there)',
    '',
    'What this computer has:',
    item.incoming ?? '(nothing — it was removed here)',
    '',
    'Write one merged version that keeps what is true in both and drops nothing either side decided, without asking me questions first.',
    `Reply with the merged text alone, between a line that says ${DRAFT_BEGIN} and a line that says ${DRAFT_END}. Do not change any file — I will review the draft and save it myself.`,
  ].join('\n')
}

/** What "Record a change" sends after the Workspace's version was kept. */
export function recordPrompt(input: { workspaceName: string; item: CollisionItemView }): string {
  const { item } = input
  return [
    `I kept the ${input.workspaceName} Workspace's version of "${item.topic}". This computer had a different one, which I want recorded as a change rather than lost.`,
    '',
    'What the Workspace says (kept):',
    item.existing ?? '(nothing)',
    '',
    'What this computer had:',
    item.incoming ?? '(nothing)',
    '',
    'Help me write what changed, and why, as a new decision that builds on the kept one.',
  ].join('\n')
}

/**
 * What the card sends into a conversation it started. The card already chose
 * the project the agent works in, so the context gate is not asked to pick
 * more (`skipContextGate`).
 */
export function collisionThreadMessage(
  threadId: string,
  content: string,
): { threadId: string; content: string; skipContextGate: true } {
  return { threadId, content, skipContextGate: true }
}

export type RecordChangeOutcome =
  | { kind: 'recorded'; threadId: string }
  | { kind: 'thread-failed' }
  | { kind: 'not-resolved' }

/**
 * "Record a change", in the only safe order: the conversation exists FIRST, so
 * the Workspace's version is never kept (and this computer's dropped) with
 * nowhere to record what changed. No conversation → nothing is resolved. The
 * choice did not save → the empty conversation is removed again. Only after
 * both does the message go out.
 */
export async function recordChange(deps: {
  createThread: () => Promise<string | null>
  keepTheirs: () => Promise<boolean>
  send: (threadId: string) => Promise<void>
  discardThread: (threadId: string) => Promise<void>
}): Promise<RecordChangeOutcome> {
  const threadId = await deps.createThread()
  if (threadId === null) return { kind: 'thread-failed' }
  const kept = await deps.keepTheirs()
  if (!kept) {
    await deps.discardThread(threadId)
    return { kind: 'not-resolved' }
  }
  await deps.send(threadId)
  return { kind: 'recorded', threadId }
}

/**
 * The merged text an agent handed back: between the two marker lines of the
 * NEWEST assistant message that has them. Null while there is none.
 */
export function extractDraft(messages: ReadonlyArray<{ role: string; content: string }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'assistant') continue
    const begin = message.content.lastIndexOf(DRAFT_BEGIN)
    if (begin < 0) continue
    const after = message.content.indexOf('\n', begin)
    if (after < 0) continue
    const end = message.content.indexOf(DRAFT_END, after)
    if (end < 0) continue
    const body = message.content.slice(after + 1, end)
    // A model may wrap the markers in a code fence; drop a fence line at either edge.
    const lines = body.split('\n')
    while (lines.length > 0 && /^\s*(```.*)?\s*$/.test(lines[0] ?? '')) lines.shift()
    while (lines.length > 0 && /^\s*(```.*)?\s*$/.test(lines[lines.length - 1] ?? '')) lines.pop()
    const text = lines.join('\n')
    return text.trim() === '' ? null : `${text}\n`
  }
  return null
}

/** Which open project a Workspace's agent thread runs in: the first of its projects open here. */
export function threadProjectFor(
  projectRoots: ReadonlyArray<string | null>,
  open: readonly string[],
): string | null {
  for (const root of projectRoots) {
    if (root === null) continue
    const match = open.find((candidate) => comparablePath(candidate) === comparablePath(root))
    if (match !== undefined) return match
  }
  return null
}

// ── For the scan ─────────────────────────────────────────────────────────────

export const FIXED_STRINGS: readonly string[] = [
  COLLISION_TITLE,
  NOTHING_WAITING,
  ALL_SETTLED,
  READ_FAILED,
  CLOSE_LABEL,
  EXISTING_HEADING,
  INCOMING_HEADING,
  MERGED_HEADING,
  CONFLICTED_HEADING,
  EMPTY_SIDE,
  TRUNCATED_LINE,
  RESOLVE_FAILED,
  SAVING_LABEL,
  KEEP_MINE,
  KEEP_THEIRS,
  USE_MERGED,
  LET_FLOW_ADAPT,
  RECORD_CHANGE,
  ADAPT_STARTED,
  USE_DRAFT_LABEL,
  NO_DRAFT_YET,
  DRAFT_HEADING,
  USE_THIS_VERSION,
  DISCARD_DRAFT,
  EMPTY_DRAFT,
  NO_PROJECT_FOR_AGENT,
  THREAD_FAILED,
  RECORDED_LINE,
  ...Object.values(ASK_HEADINGS),
  ...Object.values(REVIEW_HEADINGS),
]
