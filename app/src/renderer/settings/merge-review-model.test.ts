import type {
  WorkspaceMergeReason,
  WorkspaceMergeReview,
  WorkspaceMergeReviewItem,
  WorkspaceSyncStatus,
} from '../../shared/workspaces-contract'
import {
  AGREE_ALL_LABEL,
  EMPTY_UI_STATE,
  FIXED_STRINGS,
  REASONS_EMPTY,
  REASONS_LOADING,
  WORKING_LABEL,
  agreeSendsOnlyAgreeable,
  itemLabel,
  mergeReviewView,
  noteTitle,
  reasonAge,
  reasonsView,
  reviewKey,
  suggestionLine,
  type MergeReviewUiState,
} from './merge-review-model'
import { REVIEW_LEFTOVER_LINE, REVIEW_WAITING_LINE, syncLine } from './workspace-settings-model'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const FOURTEEN_MIN_AGO = new Date(NOW - 14 * 60_000).toISOString()

function item(id: string, state: WorkspaceMergeReviewItem['state'], extra: Partial<WorkspaceMergeReviewItem> = {}): WorkspaceMergeReviewItem {
  return {
    id,
    path: `projects/backend/brain/features/note-${id}.md`,
    kind: 'overlapping-anchors',
    take: 'theirs',
    reason: 'Different features on the same files.',
    state,
    ...extra,
  }
}

function review(partial: Partial<WorkspaceMergeReview> = {}): WorkspaceMergeReview {
  return {
    mergedAt: FOURTEEN_MIN_AGO,
    groups: [
      { key: 'kept-both', count: 5, items: ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 'pending')) },
      { key: 'took-theirs', count: 2, items: [item('f', 'agreed'), item('g', 'agreed')] },
      { key: 'merged', count: 1, items: [item('h', 'redone', { redo: { take: 'file', reason: 'Merged the two lists.' }, disagreedReason: 'Keep both lists.' })] },
    ],
    needsYou: [
      {
        id: 'n1',
        path: 'projects/backend/brain/decisions/cache-layer-choice.md',
        kind: 'decision',
        reason: 'decision-document',
        suggestion: { verdict: 'theirs', reason: 'The team benchmarked it.' },
        state: 'needs-you',
      },
    ],
    held: [],
    ...partial,
  }
}

function status(r: WorkspaceMergeReview | undefined, state: WorkspaceSyncStatus['state'] = 'review'): WorkspaceSyncStatus {
  return { state, lastSyncedAt: null, detail: null, asks: [], reviews: [], ...(r === undefined ? {} : { review: r }) }
}

function ui(partial: Partial<MergeReviewUiState> = {}): MergeReviewUiState {
  return { ...EMPTY_UI_STATE, open: new Set(), showAll: new Set(), ...partial }
}

describe('the merge review card', () => {
  it('shows nothing without a review, and nothing once everything in it is agreed', () => {
    expect(mergeReviewView(status(undefined), ui(), NOW)).toBeNull()
    expect(mergeReviewView(null, ui(), NOW)).toBeNull()
    const settled = review({ groups: [{ key: 'took-theirs', count: 1, items: [item('f', 'agreed')] }], needsYou: [] })
    expect(mergeReviewView(status(settled, 'synced'), ui(), NOW)).toBeNull()
  })

  it('still shows after a partial share, while something waits (state synced)', () => {
    const left = review({ groups: [{ key: 'kept-both', count: 1, items: [item('a', 'held')] }], needsYou: [] })
    const view = mergeReviewView(status(left, 'synced'), ui(), NOW)
    expect(view).not.toBeNull()
    expect(view?.groups[0]?.agreeableIds).toEqual(['a'])
    // A held-back decision is agreed, not disagreed.
    expect(view?.groups[0]?.disagreeableIds).toEqual([])
  })

  it('counts what is agreed, what is to review and what needs the person, with a heading in words', () => {
    const view = mergeReviewView(status(review()), ui(), NOW)
    expect(view?.title).toBe('Review the merge')
    expect(view?.subtitle).toBe('Flow decided 9 changes from the team, 14 minutes ago')
    expect(view?.summary).toEqual([
      { text: '2 agreed', tone: 'ok' },
      { text: '6 to review', tone: 'pending' },
      { text: '1 needs you', tone: 'warn' },
    ])
  })

  it('labels each group and its state', () => {
    const view = mergeReviewView(status(review()), ui(), NOW)
    expect(view?.groups.map((group) => [group.label, group.count, group.pill.text])).toEqual([
      ['Kept both notes', 5, 'To review'],
      ['Took the Workspace’s version', 2, 'Agreed'],
      ['Merged both versions', 1, 'Redone once'],
    ])
    const agreed = view?.groups[1]
    expect(agreed?.agreeableIds).toEqual([])
    expect(agreed?.canAgree).toBe(false)
  })

  it('a combine of two Workspaces is its own group, agreed as a whole and never disagreed', () => {
    const combine = item('combine:abc', 'pending', { path: '', kind: 'combine', reason: '' })
    const r = review({ groups: [{ key: 'combined', count: 1, items: [combine] }, ...review().groups] })
    const view = mergeReviewView(status(r), ui({ open: new Set(['combined']) }), NOW)
    const group = view?.groups[0]
    // The positive: the plain groups still offer Disagree…
    expect(view?.groups[1]?.canDisagree).toBe(true)
    expect(group).toMatchObject({ key: 'combined', label: 'Combined with another Workspace', canAgree: true, canDisagree: false })
    expect(group?.agreeableIds).toEqual(['combine:abc'])
    expect(group?.disagreeableIds).toEqual([])
    expect(group?.rows[0]?.label).toBe('Everything the other Workspace holds')
    expect(group?.blurb).not.toMatch(/[/`]|planflow|--/)
  })

  it('a count opens to a sample, then "Show all"', () => {
    const closed = mergeReviewView(status(review()), ui(), NOW)?.groups[0]
    expect(closed?.rows).toEqual([])
    expect(closed?.countAria).toBe('Show the 5 changes')
    const open = mergeReviewView(status(review()), ui({ open: new Set(['kept-both']) }), NOW)?.groups[0]
    expect(open?.rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(open?.rows[0]).toMatchObject({ label: 'backend · Note a', pill: { text: 'To review', tone: 'pending' } })
    expect(open?.showAllLabel).toBe('Show all 5')
    const all = mergeReviewView(status(review()), ui({ open: new Set(['kept-both']), showAll: new Set(['kept-both']) }), NOW)?.groups[0]
    expect(all?.rows).toHaveLength(5)
    expect(all?.showAllLabel).toBeNull()
  })

  it('a redone item shows the redo’s reason and the person’s own', () => {
    const merged = mergeReviewView(status(review()), ui({ open: new Set(['merged']) }), NOW)?.groups[2]
    expect(merged?.rows[0]).toMatchObject({ why: 'Merged the two lists.', yourReason: 'Your reason: “Keep both lists.”', pill: { text: 'Redone once' } })
  })

  it('"Needs you" is never agreed in bulk: no agree sends one of its ids', () => {
    const r = review({
      groups: [...review().groups, { key: 'kept-mine', count: 1, items: [item('twice', 'needs-you', { disagreedReason: 'Keep my phase order.' })] }],
    })
    const view = mergeReviewView(status(r), ui(), NOW)
    expect(view).not.toBeNull()
    if (view === null) return
    // POSITIVE FIRST: there are items to agree, and items that need the person.
    expect(view.agreeAllIds.length).toBeGreaterThan(0)
    expect(view.needsYou?.rows.map((row) => row.id)).toEqual(['n1', 'twice'])
    expect(view.agreeAllIds).not.toContain('n1')
    expect(view.agreeAllIds).not.toContain('twice')
    expect(view.groups.find((group) => group.key === 'kept-mine')?.agreeableIds).toEqual([])
    expect(agreeSendsOnlyAgreeable(view)).toBe(true)
  })

  it('a needs-you row says why, what Flow suggests, and offers the text editor with the agent’s draft', () => {
    const r = review({
      needsYou: [
        ...review().needsYou,
        { id: 'n2', path: 'projects/web/plans/plan_billing_export_v2.md', kind: 'conflict', reason: 'could-not-merge', suggestion: { verdict: 'merge', reason: '', content: 'draft\n' }, state: 'needs-you' },
      ],
    })
    const view = mergeReviewView(status(r), ui({ editing: 'n2' }), NOW)
    const [decision, plan] = view?.needsYou?.rows ?? []
    expect(decision).toMatchObject({
      title: 'Decision: Cache layer choice',
      project: 'backend',
      pill: { text: 'Team’s version kept' },
      sentence: 'Both of you edited this decision. Flow only suggests on decisions. Flow suggests keeping the team’s version.',
      agentReason: 'The team benchmarked it.',
      editing: false,
    })
    expect(plan).toMatchObject({ title: 'Plan: Billing export', editing: true, draftText: 'draft\n', canSaveText: true, agentReason: null })
    const blank = mergeReviewView(status(r), ui({ editing: 'n2', textDraft: '  ' }), NOW)?.needsYou?.rows[1]
    expect(blank?.canSaveText).toBe(false)
  })

  it('disagree requires a reason before it can be sent', () => {
    const empty = mergeReviewView(status(review()), ui({ disagreeing: 'kept-both', reasonDraft: '   ' }), NOW)?.groups[0]
    expect(empty?.disagree).toMatchObject({ question: 'Why do you disagree?', canSend: false })
    expect(empty?.canDisagree).toBe(false)
    const typed = mergeReviewView(status(review()), ui({ disagreeing: 'kept-both', reasonDraft: 'Merge them.' }), NOW)?.groups[0]
    expect(typed?.disagree?.canSend).toBe(true)
    // A group with something already redone says those come to the person next.
    const redone = mergeReviewView(status(review()), ui({ disagreeing: 'merged', reasonDraft: 'x' }), NOW)?.groups[2]
    expect(redone?.disagree?.help).toMatch(/come to you to decide/)
  })

  it('the footer agree is disabled when nothing is pending, and while a request runs', () => {
    const onlyNeeds = review({ groups: [{ key: 'took-theirs', count: 1, items: [item('f', 'agreed')] }] })
    const view = mergeReviewView(status(onlyNeeds), ui(), NOW)
    expect(view?.footerLine).toBe('Agreed groups are shared as soon as you agree. The rest waits here.')
    expect(view?.agreeAllLabel).toBe(AGREE_ALL_LABEL)
    expect(view?.canAgreeAll).toBe(false)
    const busy = mergeReviewView(status(review()), ui({ busy: true }), NOW)
    expect(busy?.canAgreeAll).toBe(false)
    expect(busy?.agreeAllLabel).toBe(WORKING_LABEL)
    expect(busy?.groups[0]?.canAgree).toBe(false)
    expect(mergeReviewView(status(review()), ui(), NOW)?.canAgreeAll).toBe(true)
  })

  it('shows a failed request’s own sentence', () => {
    expect(mergeReviewView(status(review()), ui({ notice: 'The note changed since Flow merged it.' }), NOW)?.notice).toBe(
      'The note changed since Flow merged it.',
    )
  })

  it('redraws only when the review part of a status changed', () => {
    const r = review()
    expect(reviewKey(status(r))).toBe(reviewKey({ ...status(r), lastSyncedAt: 'later', detail: 'x' }))
    expect(reviewKey(status(r))).not.toBe(reviewKey(status(review({ needsYou: [] }))))
    expect(reviewKey(status(undefined))).toBe('')
  })
})

describe('readable names', () => {
  it('turns a path into a title and a project, never a path', () => {
    expect(noteTitle('projects/web/plans/plan_billing_export_v2.md')).toBe('Billing export')
    expect(noteTitle('projects/web/discovery/discovery_search-ranking_v1.md')).toBe('Search ranking')
    expect(itemLabel('projects/web/brain/features/team-directory.md')).toBe('web · Team directory')
    expect(itemLabel('workspace.json')).toBe('Workspace')
    expect(itemLabel('projects/web/brain/features/x.md')).not.toMatch(/\//)
  })

  it('says what Flow suggests in words', () => {
    expect(suggestionLine({ verdict: 'ours', reason: '' })).toBe('Flow suggests keeping your version.')
    expect(suggestionLine({ verdict: 'unsure', reason: '' })).toBeNull()
    expect(suggestionLine(undefined)).toBeNull()
  })
})

describe('the sync line for a review', () => {
  it('says the merge waits for review, and what is left after a partial share', () => {
    expect(syncLine(status(review()), NOW)).toMatchObject({ text: REVIEW_WAITING_LINE, review: true, paused: false })
    const left = review({ groups: [{ key: 'kept-both', count: 1, items: [item('a', 'held')] }], needsYou: [] })
    expect(syncLine(status(left, 'synced'), NOW)).toMatchObject({ text: REVIEW_LEFTOVER_LINE, review: true })
    expect(syncLine(status(undefined, 'synced'), NOW).text).toBe('Up to date')
  })
})

describe('the shared merge reasons', () => {
  const reason = (partial: Partial<WorkspaceMergeReason>): WorkspaceMergeReason => ({
    id: 'r1',
    kind: 'overlapping-anchors',
    project: 'web',
    path: 'brain/features/a.md',
    take: 'both',
    summary: '',
    reason: 'Different features on the same files are not duplicates.',
    outcome: 'disagreed',
    author: 'Sam',
    ts: new Date(NOW - 2 * 86_400_000).toISOString(),
    ...partial,
  })

  it('lists reasons with a kind label, the quote, who and when', () => {
    const view = reasonsView([reason({}), reason({ id: 'r2', kind: 'decision', author: null, ts: new Date(NOW - 60_000).toISOString(), reason: 'Mine.' })], NOW, false)
    expect(view.title).toBe('Shared merge reasons')
    expect(view.line).toBeNull()
    expect(view.rows).toEqual([
      { id: 'r1', kind: 'Two features, same code', quote: 'Different features on the same files are not duplicates.', meta: 'web · Sam · 2 days ago', removeAria: expect.any(String), canRemove: true },
      { id: 'r2', kind: 'Decision', quote: 'Mine.', meta: 'web · Someone on the team · today', removeAria: expect.any(String), canRemove: true },
    ])
  })

  it('leaves out decisions with no reason, and says so when none is left', () => {
    expect(reasonsView([reason({ reason: '' })], NOW, false)).toMatchObject({ rows: [], line: REASONS_EMPTY })
    expect(reasonsView(null, NOW, false).line).toBe(REASONS_LOADING)
    expect(reasonsView('Flow could not read the shared merge reasons right now.', NOW, false).line).toMatch(/could not read/)
    expect(reasonsView([reason({})], NOW, true).rows[0]?.canRemove).toBe(false)
  })

  it('says when in words', () => {
    expect(reasonAge(new Date(NOW - 86_400_000).toISOString(), NOW)).toBe('yesterday')
    expect(reasonAge(new Date(NOW - 9 * 86_400_000).toISOString(), NOW)).toBe('last week')
    expect(reasonAge('not a time', NOW)).toBe('some time ago')
  })
})

describe('forbidden-pattern #12: nothing the review says names a command, a path, a key or an internal word', () => {
  const view = mergeReviewView(status(review()), ui({ open: new Set(['kept-both', 'merged']), disagreeing: 'merged', reasonDraft: 'x' }), NOW)
  const strings = [
    ...FIXED_STRINGS,
    view?.subtitle ?? '',
    ...(view?.summary.map((pill) => pill.text) ?? []),
    ...(view?.groups.flatMap((group) => [group.countAria, group.pill.text, ...group.rows.map((row) => row.label), group.showAllLabel ?? '', group.disagree?.help ?? '']) ?? []),
    ...(view?.needsYou?.rows.flatMap((row) => [row.title, row.sentence]) ?? []),
    REVIEW_WAITING_LINE,
    REVIEW_LEFTOVER_LINE,
  ].filter((text) => text !== '')

  it('collected a real surface (the positive before the absence)', () => {
    expect(strings.length).toBeGreaterThan(50)
    expect(strings).toContain('Agree to all groups except Needs you')
  })

  const FORBIDDEN: [string, RegExp][] = [
    ['a slash path', /[A-Za-z0-9_.~-]\/[A-Za-z0-9_.~-]|^\/|\s\/|\\/],
    ['a file extension', /\.(md|json|jsonl)\b/],
    ['the CLI', /planflow|plan-flow/i],
    ['a flag', /(^|\s)--?[a-z][a-z-]*/],
    ['a backtick', /`/],
    ['a config assignment', /\b[a-z]+_[a-z_]+\b/],
    ['an internal word', /\b(slug|payload|refus(al|ed)|CLI|IPC|JSON|ours|theirs|repo|pending|needs-you)\b/],
    ['an emoji', /\p{Extended_Pictographic}/u],
  ]

  it.each(FORBIDDEN)('contains no %s', (_what, pattern) => {
    expect(strings.filter((text) => pattern.test(text))).toEqual([])
  })
})
