/**
 * THE MERGE REVIEW — every word the "Review the merge" card and the "Shared
 * merge reasons" list say, and every decision about what they show. DOM-free,
 * so it unit-tests under the app's node jest and so the forbidden-pattern #12
 * scan in its test can see every sentence. `merge-review-card.ts` only turns
 * these answers into elements; a literal sentence in the view is a bug.
 *
 * WHAT THE CARD IS. An agent decided the changes that met in a sync, and the
 * merge is committed on this computer — nothing is shared until a person
 * agrees. The card groups the decisions by how they were settled (kept both,
 * took the team's, merged, kept yours), lets a person agree to a group or
 * disagree with a reason (the agent redoes those ONCE with it), and lists what
 * needs the person's own choice. "Needs you" is never agreed in bulk: no
 * button here sends one of those ids to an agree.
 *
 * WHAT IS DATA AND WHAT IS COPY. A note's file name and project are data,
 * shown as a readable title ("backend · Billing export"), never as a path. The
 * agent's one-line reason and a person's typed reason are data, shown as they
 * are. Everything around them is copy.
 */
import type {
  WorkspaceAgentSuggestion,
  WorkspaceAgentVerdict,
  WorkspaceMergeGroupKey,
  WorkspaceMergeItemKind,
  WorkspaceMergeItemState,
  WorkspaceMergeReason,
  WorkspaceMergeReview,
  WorkspaceMergeReviewItem,
  WorkspaceNeedsYouReason,
  WorkspaceSyncStatus,
} from '../../shared/workspaces-contract'
import { relativeTime, reviewWaits } from './workspace-settings-model'

// ── Fixed copy ──────────────────────────────────────────────────────────────

export const REVIEW_TITLE = 'Review the merge'
export const AGREE_LABEL = 'Agree'
export const DISAGREE_LABEL = 'Disagree'
export const CANCEL_LABEL = 'Cancel'
export const WORKING_LABEL = 'Working…'
export const DISAGREE_QUESTION = 'Why do you disagree?'
export const DISAGREE_HELP = 'Flow redoes only these changes with your reason. Your reason is shared with the team.'
export const DISAGREE_HELP_REDONE = 'Changes Flow already redid once come to you to decide.'
export const DISAGREE_PLACEHOLDER = 'For example: these are two parts of one feature, merge them into one note.'
export const REDO_LABEL = 'Redo with this reason'
export const NEEDS_YOU_TITLE = 'Needs you'
export const NEEDS_YOU_BLURB = 'Flow does not decide these alone. The team keeps its version until you choose.'
export const KEEP_MINE_LABEL = 'Keep mine'
export const KEEP_TEAMS_LABEL = 'Keep the team’s'
export const EDIT_TEXT_LABEL = 'Edit the text'
export const SAVE_TEXT_LABEL = 'Use this text'
export const EDIT_TEXT_PLACEHOLDER = 'Write the note as it should read.'
export const EDIT_TEXT_ARIA = 'The note’s text'
export const FOOTER_LINE = 'Agreed groups are shared as soon as you agree. The rest waits here.'
export const AGREE_ALL_LABEL = 'Agree to all groups except Needs you'
export const NOTHING_LEFT_LINE = 'Everything in this merge is decided.'
export const ACTION_FAILED_LINE = 'That did not work. Try again in a moment.'

export const REASONS_TITLE = 'Shared merge reasons'
export const REASONS_BLURB = 'Flow reads these when it decides similar changes'
export const REASONS_EMPTY = 'No reasons yet. When you disagree with a decision, your reason is kept here for the team.'
export const REASONS_LOADING = 'Reading the shared reasons…'
export const REASONS_SHOW_LABEL = 'Show'
export const REMOVE_LABEL = 'Remove'
export const SOMEONE = 'Someone on the team'

/** How many items a group's count opens to before "Show all". */
export const SAMPLE_SIZE = 3
/** The most rows one group draws even when "Show all" is on — beyond it, a line says how many more. */
export const MAX_SHOWN = 300

export type PillTone = 'ok' | 'pending' | 'warn' | 'held'

export interface Pill {
  text: string
  tone: PillTone
}

// ── Readable names for notes ────────────────────────────────────────────────

/** The project segment of a Workspace-relative path (`projects/<p>/…`), or null. */
export function projectOf(path: string): string | null {
  const parts = path.split('/')
  return parts[0] === 'projects' && parts.length > 2 && parts[1] !== '' ? parts[1] : null
}

/** "plans/plan_billing_export_v2.md" → "Billing export". Never returns a path. */
export function noteTitle(path: string): string {
  const file = path.split('/').pop() ?? ''
  const bare = file
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/^(plan|discovery|brainstorm|review|pr)_/i, '')
    .replace(/_v\d+$/i, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
  if (bare === '') return 'Untitled note'
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

type DocumentType = 'Decision' | 'Plan' | 'Discovery' | 'Brainstorm' | 'Note'

/** What kind of document a path is, by the folder it lives in. */
export function documentType(path: string): DocumentType {
  const parts = path.split('/')
  if (parts.includes('decisions')) return 'Decision'
  if (parts.includes('plans')) return 'Plan'
  if (parts.includes('discovery')) return 'Discovery'
  if (parts.includes('brainstorms')) return 'Brainstorm'
  return 'Note'
}

/** "backend · Billing export" — the project (when there is one) and the note's title. */
export function itemLabel(path: string): string {
  const project = projectOf(path)
  const title = noteTitle(path)
  return project === null ? title : `${project} · ${title}`
}

// ── Item states ─────────────────────────────────────────────────────────────

const STATE_PILLS: Record<WorkspaceMergeItemState, Pill> = {
  pending: { text: 'To review', tone: 'pending' },
  agreed: { text: 'Agreed', tone: 'ok' },
  redone: { text: 'Redone once', tone: 'warn' },
  disagreed: { text: 'Redoing with your reason', tone: 'warn' },
  'needs-you': { text: 'Team’s version kept', tone: 'held' },
  held: { text: 'Team’s version kept', tone: 'held' },
}

export function statePill(state: WorkspaceMergeItemState): Pill {
  return STATE_PILLS[state]
}

/**
 * A group item a person may agree to: the agent's decision, its redo, or a
 * decision held back while another group was shared (Agree settles it as made).
 */
export function isAgreeable(state: WorkspaceMergeItemState): boolean {
  return state === 'pending' || state === 'redone' || state === 'held'
}

/** A group item a person may disagree with: the agent's decision, or its redo (a held-back one is agreed or decided). */
export function isDisagreeable(state: WorkspaceMergeItemState): boolean {
  return state === 'pending' || state === 'redone'
}

// ── Groups ──────────────────────────────────────────────────────────────────

const GROUP_COPY: Record<WorkspaceMergeGroupKey, { label: string; blurb: string }> = {
  combined: {
    label: 'Combined with another Workspace',
    blurb: 'The shared Workspace was set up separately for the same projects. Everything it holds was merged on this computer. Nothing is shared until you agree.',
  },
  'kept-both': { label: 'Kept both notes', blurb: 'Two different notes describe the same code. Both stay as they are.' },
  'took-theirs': { label: 'Took the Workspace’s version', blurb: 'Flow kept the team’s version of these notes.' },
  merged: { label: 'Merged both versions', blurb: 'Flow wrote one note from your text and the team’s.' },
  'kept-mine': { label: 'Kept yours', blurb: 'Flow kept your version of these notes.' },
  identical: { label: 'Same on both sides', blurb: 'You and the team wrote the same thing.' },
}

export function groupLabel(key: WorkspaceMergeGroupKey): string {
  return GROUP_COPY[key].label
}

export interface ItemRowView {
  id: string
  label: string
  pill: Pill
  /** The agent's reason (its redo's, once redone). */
  why: string
  /** "Your reason: …" once the person disagreed, or null. */
  yourReason: string | null
}

export interface GroupView {
  key: WorkspaceMergeGroupKey
  label: string
  blurb: string
  count: number
  /** The count button's accessible name. */
  countAria: string
  pill: Pill
  /** The ids Agree sends — only agreeable items, never one a person must choose for. */
  agreeableIds: string[]
  /** The ids Disagree sends. */
  disagreeableIds: string[]
  canAgree: boolean
  canDisagree: boolean
  open: boolean
  rows: ItemRowView[]
  /** "Show all 600", or null when every item is already drawn. */
  showAllLabel: string | null
  /** "and 300 more" when "Show all" stops at the cap, or null. */
  moreLine: string | null
  /** The reason box under the group, when Disagree is open on it. */
  disagree: DisagreeView | null
}

export interface DisagreeView {
  question: string
  help: string
  placeholder: string
  draft: string
  /** Disabled until the person wrote something. */
  canSend: boolean
}

function groupPill(items: readonly WorkspaceMergeReviewItem[]): Pill {
  if (items.some((item) => item.state === 'pending')) return STATE_PILLS.pending
  if (items.some((item) => item.state === 'disagreed')) return STATE_PILLS.disagreed
  if (items.some((item) => item.state === 'redone')) return STATE_PILLS.redone
  if (items.some((item) => item.state === 'held')) return STATE_PILLS.held
  if (items.some((item) => item.state === 'needs-you')) return NEEDS_YOU_PILL
  return STATE_PILLS.agreed
}

const NEEDS_YOU_PILL: Pill = { text: 'Needs you', tone: 'held' }

function itemRow(item: WorkspaceMergeReviewItem): ItemRowView {
  const why = item.state === 'redone' && item.redo !== undefined ? item.redo.reason : item.reason
  return {
    id: item.id,
    label: item.kind === 'combine' ? 'Everything the other Workspace holds' : itemLabel(item.path),
    pill: statePill(item.state),
    why,
    yourReason: item.disagreedReason === undefined || item.disagreedReason === '' ? null : `Your reason: “${item.disagreedReason}”`,
  }
}

function changes(count: number): string {
  return count === 1 ? '1 change' : `${count} changes`
}

// ── Needs you ───────────────────────────────────────────────────────────────

export interface NeedsYouRowView {
  id: string
  title: string
  project: string | null
  pill: Pill
  /** Why Flow left it to the person, and what it would do. */
  sentence: string
  /** The agent's own reason for its suggestion, when it gave one. */
  agentReason: string | null
  editing: boolean
  /** What the text editor starts with (the agent's drafted text, when it wrote one). */
  draftText: string
  canSaveText: boolean
}

const NEEDS_YOU_REASONS: Record<WorkspaceNeedsYouReason, string> = {
  'agent-unavailable': 'Flow could not ask its agent this time, so you decide.',
  'decision-document': 'Both of you edited this decision. Flow only suggests on decisions.',
  deletion: 'One side deleted this note and the other changed it. Flow only suggests on deletions.',
  truncated: 'Flow could not read the whole note, so it did not decide.',
  'one-sided': 'Only one side of this note could be read, so Flow did not decide.',
  unsure: 'Flow could not tell which version is right.',
  'unreadable-answer': 'Flow’s answer for this note could not be read.',
  'could-not-merge': 'Flow could not write one note from both versions.',
  cap: 'Flow reached its limit of merges for this sync.',
  'not-offered': 'Flow’s answer is not a choice this note allows.',
}

const VERDICT_PHRASES: Record<WorkspaceAgentVerdict, string | null> = {
  ours: 'keeping your version',
  theirs: 'keeping the team’s version',
  both: 'keeping both notes',
  merge: 'merging both versions',
  unsure: null,
}

/** "Flow suggests keeping the team's version." — or null when it had no suggestion. */
export function suggestionLine(suggestion: WorkspaceAgentSuggestion | undefined): string | null {
  if (suggestion === undefined) return null
  const phrase = VERDICT_PHRASES[suggestion.verdict]
  return phrase === null ? null : `Flow suggests ${phrase}.`
}

function needsYouTitle(path: string, kind: WorkspaceMergeItemKind, reason: WorkspaceNeedsYouReason | null): string {
  const title = noteTitle(path)
  if (reason === 'truncated') return `Note too long to compare: ${title}`
  if (reason === 'deletion' || kind === 'modify-delete') return `Deleted on one side: ${title}`
  return `${documentType(path)}: ${title}`
}

interface NeedsYouSource {
  id: string
  path: string
  kind: WorkspaceMergeItemKind
  reason: WorkspaceNeedsYouReason | null
  suggestion?: WorkspaceAgentSuggestion
  disagreedReason?: string
  state: WorkspaceMergeItemState
  draft?: string
}

/** Every item only a person settles: the "needs you" list, group items disagreed twice, and anything held with no decision. */
function needsYouSources(review: WorkspaceMergeReview): NeedsYouSource[] {
  const out: NeedsYouSource[] = []
  const seen = new Set<string>()
  for (const entry of review.needsYou) {
    seen.add(entry.id)
    if (entry.state === 'agreed') continue
    out.push({ id: entry.id, path: entry.path, kind: entry.kind, reason: entry.reason, ...(entry.suggestion === undefined ? {} : { suggestion: entry.suggestion }), state: 'needs-you' })
  }
  for (const group of review.groups) {
    for (const item of group.items) {
      seen.add(item.id)
      // A held group item keeps its decision and is agreed in its group; only a person's own choice is listed here.
      if (item.state !== 'needs-you') continue
      out.push({
        id: item.id,
        path: item.path,
        kind: item.kind,
        reason: null,
        ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
        ...(item.disagreedReason === undefined ? {} : { disagreedReason: item.disagreedReason }),
        state: 'needs-you',
        ...(item.redo?.content === undefined ? {} : { draft: item.redo.content }),
      })
    }
  }
  for (const held of review.held) {
    if (seen.has(held.id) || (held.state !== undefined && held.state !== 'held')) continue
    out.push({ id: held.id, path: held.path, kind: held.kind, reason: null, state: 'held' })
  }
  return out
}

function needsYouSentence(source: NeedsYouSource): string {
  const suggestion = suggestionLine(source.suggestion)
  let lead: string
  if (source.reason !== null) lead = NEEDS_YOU_REASONS[source.reason]
  else if (source.disagreedReason !== undefined && source.disagreedReason !== '') lead = `You disagreed twice. Your reason: “${source.disagreedReason}”`
  else if (source.state === 'held') lead = 'Your version is kept aside on this computer, and Flow remembers no decision for it.'
  else lead = 'Flow left this one to you.'
  return suggestion === null ? lead : `${lead} ${suggestion}`
}

// ── The card ────────────────────────────────────────────────────────────────

/** What the person is in the middle of — kept by the view across redraws. */
export interface MergeReviewUiState {
  /** Groups whose count is open. */
  open: ReadonlySet<WorkspaceMergeGroupKey>
  /** Groups showing every item rather than the sample. */
  showAll: ReadonlySet<WorkspaceMergeGroupKey>
  /** The group whose Disagree box is open, and what is typed in it. */
  disagreeing: WorkspaceMergeGroupKey | null
  reasonDraft: string
  /** The "needs you" item whose text editor is open, and what is typed in it (null = not edited yet). */
  editing: string | null
  textDraft: string | null
  /** A request is running: every button waits. */
  busy: boolean
  /** The sentence of the last request that did not work, or null. */
  notice: string | null
}

export const EMPTY_UI_STATE: MergeReviewUiState = {
  open: new Set(),
  showAll: new Set(),
  disagreeing: null,
  reasonDraft: '',
  editing: null,
  textDraft: null,
  busy: false,
  notice: null,
}

export interface MergeReviewView {
  title: string
  /** "Flow decided 756 changes from the team, 14 minutes ago". */
  subtitle: string
  summary: Pill[]
  groups: GroupView[]
  needsYou: { title: string; blurb: string; count: number; rows: NeedsYouRowView[] } | null
  footerLine: string
  agreeAllLabel: string
  /** Every agreeable id across the groups — never one from "Needs you". The view sends `allGroups`, which the engine resolves to the same set. */
  agreeAllIds: string[]
  canAgreeAll: boolean
  /** Shown when nothing is left to look at. */
  doneLine: string | null
  notice: string | null
  busy: boolean
}

/** The card for a status, or null when no review is open. */
export function mergeReviewView(status: WorkspaceSyncStatus | null, ui: MergeReviewUiState, now: number): MergeReviewView | null {
  const review = status?.review
  if (review === undefined || !reviewWaits(review)) return null
  const groups = review.groups.filter((group) => group.items.length > 0).map((group) => groupView(group.key, group.count, group.items, ui))
  const sources = needsYouSources(review)
  const rows = sources.map((source): NeedsYouRowView => {
    const editing = ui.editing === source.id
    const draftText = editing && ui.textDraft !== null ? ui.textDraft : (source.draft ?? source.suggestion?.content ?? '')
    return {
      id: source.id,
      title: needsYouTitle(source.path, source.kind, source.reason),
      project: projectOf(source.path),
      pill: statePill(source.state === 'held' ? 'held' : 'needs-you'),
      sentence: needsYouSentence(source),
      agentReason: source.suggestion !== undefined && source.suggestion.reason.trim() !== '' ? source.suggestion.reason : null,
      editing,
      draftText,
      canSaveText: !ui.busy && draftText.trim() !== '',
    }
  })

  const items = review.groups.flatMap((group) => group.items)
  const agreed = items.filter((item) => item.state === 'agreed').length + review.needsYou.filter((entry) => entry.state === 'agreed').length
  const toReview = items.filter((item) => isAgreeable(item.state)).length
  const summary: Pill[] = []
  if (agreed > 0) summary.push({ text: `${agreed} agreed`, tone: 'ok' })
  if (toReview > 0) summary.push({ text: `${toReview} to review`, tone: 'pending' })
  if (rows.length > 0) summary.push({ text: rows.length === 1 ? '1 needs you' : `${rows.length} need you`, tone: 'warn' })

  const agreeAllIds = groups.flatMap((group) => group.agreeableIds)
  const total = review.groups.reduce((sum, group) => sum + group.count, 0) + review.needsYou.length
  return {
    title: REVIEW_TITLE,
    subtitle: `Flow decided ${changes(total)} from the team, ${relativeTime(review.mergedAt, now)}`,
    summary,
    groups,
    needsYou: rows.length === 0 ? null : { title: NEEDS_YOU_TITLE, blurb: NEEDS_YOU_BLURB, count: rows.length, rows },
    footerLine: FOOTER_LINE,
    agreeAllLabel: ui.busy ? WORKING_LABEL : AGREE_ALL_LABEL,
    agreeAllIds,
    canAgreeAll: !ui.busy && agreeAllIds.length > 0,
    doneLine: agreeAllIds.length === 0 && rows.length === 0 ? NOTHING_LEFT_LINE : null,
    notice: ui.notice,
    busy: ui.busy,
  }
}

function groupView(
  key: WorkspaceMergeGroupKey,
  count: number,
  items: readonly WorkspaceMergeReviewItem[],
  ui: MergeReviewUiState,
): GroupView {
  const agreeableIds = items.filter((item) => isAgreeable(item.state)).map((item) => item.id)
  // A combine is agreed or left as a whole — there is nothing for the agent to redo.
  const disagreeableIds = key === 'combined' ? [] : items.filter((item) => isDisagreeable(item.state)).map((item) => item.id)
  const open = ui.open.has(key)
  const all = ui.showAll.has(key)
  const limit = all ? MAX_SHOWN : SAMPLE_SIZE
  const shown = open ? items.slice(0, limit) : []
  const rest = items.length - Math.min(items.length, limit)
  const disagreeing = ui.disagreeing === key && disagreeableIds.length > 0
  const hasRedone = items.some((item) => item.state === 'redone')
  return {
    key,
    label: GROUP_COPY[key].label,
    blurb: GROUP_COPY[key].blurb,
    count,
    countAria: open ? `Hide the ${changes(count)}` : `Show the ${changes(count)}`,
    pill: groupPill(items),
    agreeableIds,
    disagreeableIds,
    canAgree: !ui.busy && agreeableIds.length > 0,
    canDisagree: !ui.busy && disagreeableIds.length > 0 && !disagreeing,
    open,
    rows: shown.map(itemRow),
    showAllLabel: open && !all && rest > 0 ? `Show all ${items.length}` : null,
    moreLine: open && all && rest > 0 ? `and ${rest} more` : null,
    disagree: disagreeing
      ? {
          question: DISAGREE_QUESTION,
          help: hasRedone ? `${DISAGREE_HELP} ${DISAGREE_HELP_REDONE}` : DISAGREE_HELP,
          placeholder: DISAGREE_PLACEHOLDER,
          draft: ui.reasonDraft,
          canSend: !ui.busy && ui.reasonDraft.trim() !== '',
        }
      : null,
  }
}

/** Whether the review part of a status changed — the card redraws only then (allowed-pattern #17). */
export function reviewKey(status: WorkspaceSyncStatus | null): string {
  const review = status?.review
  return review === undefined ? '' : JSON.stringify(review)
}

/** True when nothing in "Needs you" can reach an agree: the ids an agree sends never include one. */
export function agreeSendsOnlyAgreeable(view: MergeReviewView): boolean {
  const personal = new Set((view.needsYou?.rows ?? []).map((row) => row.id))
  return view.agreeAllIds.every((id) => !personal.has(id)) && view.groups.every((group) => group.agreeableIds.every((id) => !personal.has(id)))
}

// ── Shared merge reasons ────────────────────────────────────────────────────

const KIND_LABELS: Record<WorkspaceMergeItemKind, string> = {
  decision: 'Decision',
  'same-feature': 'Same feature note',
  'overlapping-anchors': 'Two features, same code',
  'same-discovery': 'Same discovery',
  conflict: 'Both edited a note',
  'add-add': 'Both added a note',
  'modify-delete': 'Changed and deleted',
  combine: 'Combined Workspaces',
}

export function kindLabel(kind: WorkspaceMergeItemKind): string {
  return KIND_LABELS[kind]
}

/** "today", "yesterday", "3 days ago", "last week", "5 weeks ago" — when a reason was recorded. */
export function reasonAge(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'some time ago'
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.max(0, Math.ceil((startOfToday.getTime() - then) / 86_400_000))
  if (then >= startOfToday.getTime() || days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return 'last week'
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  const months = Math.floor(days / 30)
  return months < 24 ? `${months} months ago` : `${Math.floor(days / 365)} years ago`
}

export interface ReasonRowView {
  id: string
  kind: string
  /** The person's reason, as they wrote it. */
  quote: string
  /** "backend · Sam · 2 days ago". */
  meta: string
  removeAria: string
  canRemove: boolean
}

export interface ReasonsView {
  title: string
  blurb: string
  rows: ReasonRowView[]
  /** Shown instead of rows: still reading, nothing recorded, or why it could not be read. */
  line: string | null
}

/**
 * The reasons list. `reasons` is null while it has not been read, or a
 * sentence when it could not be. Only decisions that carry a reason are
 * listed — an agreement with nothing to say teaches the agent nothing.
 */
export function reasonsView(reasons: readonly WorkspaceMergeReason[] | string | null, now: number, busy: boolean): ReasonsView {
  const base = { title: REASONS_TITLE, blurb: REASONS_BLURB }
  if (reasons === null) return { ...base, rows: [], line: REASONS_LOADING }
  if (typeof reasons === 'string') return { ...base, rows: [], line: reasons }
  const rows = reasons
    .filter((reason) => reason.reason.trim() !== '')
    .map((reason): ReasonRowView => ({
      id: reason.id,
      kind: kindLabel(reason.kind),
      quote: reason.reason,
      meta: [reason.project, reason.author ?? SOMEONE, reasonAge(reason.ts, now)].filter((part) => part !== '').join(' · '),
      removeAria: `Remove the reason “${reason.reason}”`,
      canRemove: !busy,
    }))
  return { ...base, rows, line: rows.length === 0 ? REASONS_EMPTY : null }
}

/** Every fixed sentence, for the forbidden-pattern #12 scan. */
export const FIXED_STRINGS: readonly string[] = [
  REVIEW_TITLE,
  AGREE_LABEL,
  DISAGREE_LABEL,
  CANCEL_LABEL,
  WORKING_LABEL,
  DISAGREE_QUESTION,
  DISAGREE_HELP,
  DISAGREE_HELP_REDONE,
  DISAGREE_PLACEHOLDER,
  REDO_LABEL,
  NEEDS_YOU_TITLE,
  NEEDS_YOU_BLURB,
  KEEP_MINE_LABEL,
  KEEP_TEAMS_LABEL,
  EDIT_TEXT_LABEL,
  SAVE_TEXT_LABEL,
  EDIT_TEXT_PLACEHOLDER,
  EDIT_TEXT_ARIA,
  FOOTER_LINE,
  AGREE_ALL_LABEL,
  NOTHING_LEFT_LINE,
  ACTION_FAILED_LINE,
  REASONS_TITLE,
  REASONS_BLURB,
  REASONS_EMPTY,
  REASONS_LOADING,
  REASONS_SHOW_LABEL,
  REMOVE_LABEL,
  SOMEONE,
  ...Object.values(GROUP_COPY).flatMap((copy) => [copy.label, copy.blurb]),
  ...Object.values(STATE_PILLS).map((pill) => pill.text),
  NEEDS_YOU_PILL.text,
  ...Object.values(NEEDS_YOU_REASONS),
  ...Object.values(KIND_LABELS),
]
