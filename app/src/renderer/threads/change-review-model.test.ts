// Pure model tests for the thread change-review card (#1906). No DOM — these
// pin the helpers the card renders from, and (Task 5.3) the perf GATE: a batch
// of update events for other threads must all answer "does not affect me",
// which is exactly what stops the card fetching. The gate returning false IS the
// zero-fetch guarantee, expressed without a jsdom harness.

import type {
  ChangeReviewFile,
  GitPublishResult,
  ThreadChangeReview,
} from '../../shared/ipc-contract'
import {
  canRenameReviewBranch,
  commitBoxState,
  selectAllState,
  changeReviewAffectsThread,
  changeReviewToolbarState,
  changesStripState,
  fileBadge,
  partitionReviewFiles,
  fileChangeAffectsRoot,
  formatCounts,
  publishOutcomeSentence,
  publishOutcomeTone,
  reviewableFiles,
  statusLabel,
  summarizeReview,
} from './change-review-model'

function file(overrides: Partial<ChangeReviewFile> & { filePath: string }): ChangeReviewFile {
  return {
    status: 'modified',
    staged: false,
    added: null,
    deleted: null,
    binary: false,
    touchedOnly: false,
    ...overrides,
  }
}

function review(
  files: ChangeReviewFile[],
  ownWorktree = true,
  branch: string | null = 'main',
  extra: Partial<Pick<ThreadChangeReview, 'state' | 'aheadCommits' | 'bound'>> = {},
): ThreadChangeReview {
  return {
    threadId: 't1',
    rootId: '/repo',
    ownWorktree,
    branch,
    state: 'uncommitted',
    aheadCommits: 0,
    // Unaimed by default, matching the resolver's own cautious answer for a
    // checkout whose branch git has no upstream for; `extra` overrides it.
    bound: false,
    files,
    ...extra,
  }
}

describe('changeReviewAffectsThread (the perf gate)', () => {
  it('is true only for the active thread', () => {
    expect(changeReviewAffectsThread({ threadId: 't1' }, 't1')).toBe(true)
    expect(changeReviewAffectsThread({ threadId: 't2' }, 't1')).toBe(false)
    expect(changeReviewAffectsThread({ threadId: 't1' }, null)).toBe(false)
  })

  it('answers false for a whole batch aimed at other threads — zero fetches', () => {
    const batch = ['t2', 't3', 't4', 't5', 't6'].map((threadId) => ({ threadId }))
    const affected = batch.filter((event) => changeReviewAffectsThread(event, 't1'))
    expect(affected).toHaveLength(0)
  })
})

describe('fileChangeAffectsRoot', () => {
  it('matches on the active root only', () => {
    expect(fileChangeAffectsRoot('/repo', '/repo')).toBe(true)
    expect(fileChangeAffectsRoot('/other', '/repo')).toBe(false)
    expect(fileChangeAffectsRoot(undefined, '/repo')).toBe(false)
    expect(fileChangeAffectsRoot('/repo', null)).toBe(false)
  })
})

describe('formatCounts', () => {
  it('renders both, one, or neither', () => {
    expect(formatCounts(12, 3)).toBe('+12 −3')
    expect(formatCounts(5, 0)).toBe('+5')
    expect(formatCounts(0, 2)).toBe('−2')
    expect(formatCounts(null, null)).toBe('')
    expect(formatCounts(0, 0)).toBe('')
  })
})

describe('reviewableFiles', () => {
  it('excludes touched-only entries', () => {
    const r = review([
      file({ filePath: 'a.ts' }),
      file({ filePath: 'b.ts', touchedOnly: true }),
    ])
    expect(reviewableFiles(r).map((f) => f.filePath)).toEqual(['a.ts'])
    expect(reviewableFiles(null)).toEqual([])
  })
})

describe('summarizeReview', () => {
  it('totals counts and separates reviewable from touched-only', () => {
    const r = review([
      file({ filePath: 'a.ts', added: 3, deleted: 1 }),
      file({ filePath: 'b.ts', added: 2, deleted: null }),
      file({ filePath: 'c.ts', touchedOnly: true }),
    ])
    expect(summarizeReview(r)).toEqual({ fileCount: 3, reviewableCount: 2, added: 5, deleted: 1 })
  })

  it('reports null totals when no file carried a count', () => {
    const r = review([file({ filePath: 'a.ts' })])
    expect(summarizeReview(r)).toEqual({ fileCount: 1, reviewableCount: 1, added: null, deleted: null })
  })
})

describe('statusLabel', () => {
  it("reads a touched-only file as 'touched'", () => {
    expect(statusLabel(file({ filePath: 'a.ts', touchedOnly: true }))).toBe('touched')
    expect(statusLabel(file({ filePath: 'a.ts', status: 'added' }))).toBe('added')
  })
})

describe('changesStripState — the strip above the composer (#1906)', () => {
  it('shows the totals the way Cursor does', () => {
    const state = changesStripState(
      review([
        file({ filePath: 'app.json', added: 1455, deleted: 5 }),
        file({ filePath: 'src/a.ts', added: 5, deleted: null }),
      ]),
    )
    expect(state.show).toBe(true)
    expect(state.added).toBe('+1460')
    expect(state.deleted).toBe('−5')
  })

  it('HIDES when the thread has changed nothing', () => {
    // The strip is a notice, and a notice about nothing is noise. The PANEL is
    // a place, and it says so in words instead — the two rules are opposite on
    // purpose (see the card's empty state).
    expect(changesStripState(review([])).show).toBe(false)
    expect(changesStripState(null).show).toBe(false)
  })

  it('still shows for files with no counted lines — an untracked file is a change', () => {
    const state = changesStripState(review([file({ filePath: 'new.bin', binary: true })]))
    expect(state.show).toBe(true)
    expect(state.added).toBe('')
    expect(state.deleted).toBe('')
  })

  it('keeps the numbers OUT of the label, so no diff can set the control’s width', () => {
    const state = changesStripState(review([file({ filePath: 'a.ts', added: 999999, deleted: 1 })]))
    expect(state.label).toBe('Changes')
  })

  it('counts files, not lines, in the hover text — and gets the plural right', () => {
    expect(changesStripState(review([file({ filePath: 'a.ts' })])).title).toContain('1 file ')
    expect(
      changesStripState(review([file({ filePath: 'a.ts' }), file({ filePath: 'b.ts' })])).title,
    ).toContain('2 files ')
  })

  it('will NOT call the project’s uncommitted work "what this conversation changed"', () => {
    // On a conversation's own branch nothing else writes there, so it is true.
    // In the project's tree the list is every uncommitted change — the agent's,
    // yours, and whatever was already there. Same files, and only one of the two
    // sentences is honest, on the screen where a person decides what to discard.
    const own = changesStripState(review([file({ filePath: 'a.ts', added: 2 })], true))
    const shared = changesStripState(review([file({ filePath: 'a.ts', added: 2 })], false))
    expect(own.title).toContain('this conversation changed')
    expect(shared.title).toContain('uncommitted')
    expect(shared.title).not.toContain('this conversation changed')
    // Both still say the same thing on the control itself.
    expect(shared.label).toBe(own.label)
    expect(shared.added).toBe(own.added)
  })

  it('names no path, command or config key', () => {
    const state = changesStripState(review([file({ filePath: 'src/secret/a.ts', added: 2 })]))
    expect(`${state.label} ${state.title}`).not.toContain('src/secret')
    expect(`${state.label} ${state.title}`).not.toMatch(/worktree|planflow-ai|git /)
  })
})

describe('changeReviewToolbarState — the review’s own second row', () => {
  it('names the scope, the size and where a commit would land', () => {
    const state = changeReviewToolbarState(
      review([file({ filePath: 'a.ts', added: 1460, deleted: 5 })], false, 'main'),
    )
    expect(state).toMatchObject({
      scope: 'Uncommitted',
      added: '+1460',
      deleted: '−5',
      branch: 'main',
    })
  })

  it('says ONE word wherever the files live, and puts the difference in the tooltip', () => {
    // `Uncommitted` is true of a thread's own checkout and of the project's
    // tree alike. What differs is who ELSE could have written these files, and
    // that is a tooltip, not a heading — a heading that changed with Flow's
    // model of the thread made the row about the model rather than the files.
    const own = changeReviewToolbarState(review([file({ filePath: 'a.ts' })], true, 'thread/x'))
    const shared = changeReviewToolbarState(review([file({ filePath: 'a.ts' })], false, 'main'))
    expect(own.scope).toBe('Uncommitted')
    expect(shared.scope).toBe('Uncommitted')
    expect(own.scopeTitle).toContain('its own branch')
    expect(shared.scopeTitle).toContain('whoever changed it')
  })

  it('reports a detached / unknown branch as absent rather than blank', () => {
    // A blank chip reads as "a branch with no name"; null is what the toolbar
    // hides, so nothing on screen claims a destination that does not exist.
    expect(changeReviewToolbarState(review([], false, null)).branch).toBeNull()
    expect(changeReviewToolbarState(null).branch).toBeNull()
  })

  it('never puts the branch inside a sentence a control has to fit', () => {
    const state = changeReviewToolbarState(review([], false, 'a'.repeat(80)))
    expect(state.scope.length).toBeLessThan(24)
    expect(state.scopeTitle).not.toContain('aaaa')
  })
})

describe('the file list vs the files that only got touched', () => {
  it('splits them, because nine touched files once buried the one that changed', () => {
    const { changed, touched } = partitionReviewFiles(
      review([
        file({ filePath: 'real.ts', added: 3 }),
        file({ filePath: 'opened.ts', touchedOnly: true }),
        file({ filePath: 'opened2.ts', touchedOnly: true }),
      ]),
    )
    expect(changed.map((f) => f.filePath)).toEqual(['real.ts'])
    expect(touched.map((f) => f.filePath)).toEqual(['opened.ts', 'opened2.ts'])
  })

  it('is empty on both sides for no review at all', () => {
    expect(partitionReviewFiles(null)).toEqual({ changed: [], touched: [] })
  })
})

describe('fileBadge', () => {
  it('marks a file that did not exist before, and stays quiet on an edit', () => {
    expect(fileBadge(file({ filePath: 'a.ts', status: 'untracked' }))).toBe('New')
    expect(fileBadge(file({ filePath: 'a.ts', status: 'added' }))).toBe('New')
    expect(fileBadge(file({ filePath: 'a.ts', status: 'modified' }))).toBe('')
    expect(fileBadge(file({ filePath: 'a.ts', status: 'deleted' }))).toBe('')
  })
})

describe('the committed state — a record, not a decision', () => {
  const committed = review([file({ filePath: 'a.ts', added: 20, deleted: 2 })], false, 'fix/x', {
    state: 'committed',
    aheadCommits: 2,
  })

  it('says Committed, and says how much is waiting to be pushed', () => {
    const state = changeReviewToolbarState(committed)
    expect(state.scope).toBe('Committed')
    expect(state.aheadCommits).toBe(2)
    expect(state.scopeTitle).toContain('not pushed')
  })

  it('is read-only — there is nothing left to keep or reject', () => {
    // A commit does not make the work disappear; it moves it one step along.
    // Offering Keep, Reject or Commit over it would either lie or do something
    // nobody asked for.
    expect(changeReviewToolbarState(committed).readOnly).toBe(true)
  })

  it('leaves the ordinary state alone', () => {
    const state = changeReviewToolbarState(review([file({ filePath: 'a.ts', added: 1 })]))
    expect(state.scope).toBe('Uncommitted')
    expect(state.readOnly).toBe(false)
    expect(state.aheadCommits).toBe(0)
  })
})

describe('showPush — when a Push control belongs in the toolbar at all', () => {
  const changed = [file({ filePath: 'a.ts', added: 4 })]

  it('offers it for a branch that is aimed somewhere and has commits waiting', () => {
    const state = changeReviewToolbarState(
      review(changed, true, 'feat/x', { state: 'committed', aheadCommits: 2, bound: true }),
    )
    expect(state.showPush).toBe(true)
    // It is keyed on the same number the chip beside it prints.
    expect(state.aheadCommits).toBe(2)
  })

  it('withholds it for a branch that is aimed somewhere and already there', () => {
    // Bound and level: publishing would send nothing, so there is nothing to
    // offer. This is the ONLY case where a zero count means "nothing to push".
    const state = changeReviewToolbarState(
      review(changed, true, 'feat/x', { state: 'committed', aheadCommits: 0, bound: true }),
    )
    expect(state.showPush).toBe(false)
  })

  it('offers it for an unbound branch WITH commits waiting', () => {
    const state = changeReviewToolbarState(
      review(changed, true, 'feat/x', { state: 'committed', aheadCommits: 3, bound: false }),
    )
    expect(state.showPush).toBe(true)
  })

  it('offers it for an unbound branch reporting zero — the case the count cannot answer', () => {
    // THIS IS R1, AND IT IS WHY THE RULE COSTS NO EXTRA GIT READ. A branch
    // nobody has aimed anywhere reports `aheadCommits: 0` for the same reason a
    // fully-published branch does: there is no upstream for it to be ahead OF.
    // Keying the control on the count alone would hide it from every branch
    // that has never been published — exactly the branches that most need it.
    // `bound` is the fact that separates the two, and it is already on the
    // review.
    const state = changeReviewToolbarState(
      review(changed, true, 'feat/x', { state: 'committed', aheadCommits: 0, bound: false }),
    )
    expect(state.showPush).toBe(true)
    expect(state.aheadCommits).toBe(0)
  })

  it('shows nothing at all for no review — there is no branch to publish', () => {
    expect(changeReviewToolbarState(null).showPush).toBe(false)
  })

  it('shows nothing for a detached head, which is unbound and unpublishable', () => {
    // The unbound half of the rule would otherwise offer a push for a checkout
    // whose branch does not exist. The guard only ever removes the control.
    const state = changeReviewToolbarState(review(changed, true, null, { bound: false }))
    expect(state.showPush).toBe(false)
  })
})

describe('publishOutcomeSentence — the four answers and the one question', () => {
  it('says what was published and where', () => {
    expect(
      publishOutcomeSentence({
        status: 'published',
        remote: 'origin',
        remoteBranch: 'feature/PF-42',
      }),
    ).toBe('Published to origin/feature/PF-42.')
  })

  it('mentions an older name still sitting on the remote after a rename', () => {
    const sentence = publishOutcomeSentence({
      status: 'published',
      remote: 'origin',
      remoteBranch: 'feature/new',
      previouslyPushedAs: 'feature/old',
    })
    // A rename re-points the upstream and leaves the old ref where it was; the
    // reader is told, because otherwise two branches quietly exist.
    expect(sentence).toContain('feature/old')
    expect(sentence).toContain('origin/feature/new')
  })

  it('refuses a diverged branch in words, and offers no pull', () => {
    const sentence = publishOutcomeSentence({ status: 'diverged', behind: 2 })
    expect(sentence).toContain('2 commits')
    expect(sentence).toContain('Nothing was sent')
    // No force, no pull, no rebase — not as a control and not as an
    // instruction. The refusal is the whole response.
    expect(sentence?.toLowerCase()).not.toContain('force')
    expect(sentence?.toLowerCase()).not.toContain('rebase')
  })

  it('counts one behind commit in the singular', () => {
    expect(publishOutcomeSentence({ status: 'diverged', behind: 1 })).toContain('1 commit this')
  })

  it('says so and stops when there was nothing to publish', () => {
    expect(publishOutcomeSentence({ status: 'nothing' })).toBe(
      'Everything on this branch is already published.',
    )
  })

  it('passes a failure through whole rather than wrapping it in a second sentence', () => {
    // Main already trimmed any invocation off it at the display boundary; a
    // wrapper here would only put the app between the reader and what the
    // repository actually said.
    const detail = 'The remote refused the connection.'
    expect(publishOutcomeSentence({ status: 'failed', detail })).toBe(detail)
  })

  it('says nothing for an unbound branch, because the honest answer is a question', () => {
    // Phase 5 owns the ask. A placeholder line here would be a dead end sitting
    // exactly where a decision belongs (forbidden-pattern #12's shape).
    expect(
      publishOutcomeSentence({
        status: 'unbound',
        suggestion: {
          suggestion: 'feature/PF-42',
          source: 'ticket',
          remote: 'origin',
          remotes: ['origin'],
          base: 'main',
        },
      }),
    ).toBeNull()
  })

  it('passes the three ways an answer can be unusable through whole', () => {
    // Each of them is already a sentence about this repository, written by main
    // and trimmed at the display boundary. What differs between the three is
    // what the card DOES next — re-ask, re-ask pointing at the blank, or stop —
    // and that is read off the status, never off the words.
    const unconfirmed = 'Choosing where this branch publishes needs someone to ask for it.'
    const incomplete = 'Say where this work should be published.'
    const bindFailed = 'This project would not record where the branch publishes.'
    expect(publishOutcomeSentence({ status: 'unconfirmed', detail: unconfirmed })).toBe(unconfirmed)
    expect(publishOutcomeSentence({ status: 'incomplete', detail: incomplete })).toBe(incomplete)
    expect(publishOutcomeSentence({ status: 'bind-failed', detail: bindFailed })).toBe(bindFailed)
  })

  it('hands the reader no command, no path and no config key — in any of them', () => {
    // FORBIDDEN-PATTERN #12, pinned. This toolbar has no terminal behind it, so
    // an invocation in one of these sentences is a dead end wearing a
    // sentence's clothes. Checked across every outcome that authors its own
    // words, including a failure detail, which is the one string that arrives
    // from outside.
    const outcomes: GitPublishResult[] = [
      { status: 'published', remote: 'origin', remoteBranch: 'feature/x' },
      { status: 'published', remote: 'origin', remoteBranch: 'b', previouslyPushedAs: 'a' },
      { status: 'diverged', behind: 4 },
      { status: 'nothing' },
      { status: 'failed', detail: 'The remote refused the connection.' },
      { status: 'unconfirmed', detail: 'Choosing where this goes needs someone to ask for it.' },
      { status: 'incomplete', detail: 'Say where this work should be published.' },
      { status: 'bind-failed', detail: 'This project would not record where the branch goes.' },
    ]
    for (const outcome of outcomes) {
      const sentence = publishOutcomeSentence(outcome) ?? ''
      expect(sentence).not.toContain('`')
      expect(sentence).not.toContain('/Users/')
      expect(sentence).not.toContain('./')
      expect(sentence.toLowerCase()).not.toContain('git ')
      expect(sentence.toLowerCase()).not.toContain('planflow-ai')
      expect(sentence).not.toMatch(/^[a-z_]+:/i)
    }
  })
})

describe('publishOutcomeTone — a refusal is not an error', () => {
  it('reads a publish and a no-op as the system working', () => {
    expect(publishOutcomeTone({ status: 'published', remote: 'o', remoteBranch: 'b' })).toBe('ok')
    expect(publishOutcomeTone({ status: 'nothing' })).toBe('ok')
  })

  it('reads the two refusals and a failure as something that did not happen', () => {
    expect(publishOutcomeTone({ status: 'diverged', behind: 1 })).toBe('refused')
    expect(publishOutcomeTone({ status: 'failed', detail: 'x' })).toBe('refused')
  })

  it('reads an unusable answer the same way — nothing was sent', () => {
    expect(publishOutcomeTone({ status: 'unconfirmed', detail: 'x' })).toBe('refused')
    expect(publishOutcomeTone({ status: 'incomplete', detail: 'x' })).toBe('refused')
    expect(publishOutcomeTone({ status: 'bind-failed', detail: 'x' })).toBe('refused')
  })
})

describe('selectAllState — the head of the checkbox column', () => {
  const loose = (name: string) => file({ filePath: name, staged: false })
  const kept = (name: string) => file({ filePath: name, staged: true })

  it('has no head on an empty column', () => {
    expect(selectAllState([], false).hidden).toBe(true)
  })

  it('has no head on work already committed — there is nothing left to decide', () => {
    expect(selectAllState([kept('a.ts'), loose('b.ts')], true).hidden).toBe(true)
  })

  it('offers to keep everything when nothing is kept', () => {
    const state = selectAllState([loose('a.ts'), loose('b.ts')], false)
    expect(state).toMatchObject({ hidden: false, checked: false, indeterminate: false, action: 'keep' })
    expect(state.filePaths).toEqual(['a.ts', 'b.ts'])
  })

  it('shows the dash when some are kept, and the press completes the selection', () => {
    const state = selectAllState([kept('a.ts'), loose('b.ts'), loose('c.ts')], false)
    expect(state.indeterminate).toBe(true)
    expect(state.checked).toBe(false)
    expect(state.action).toBe('keep')
    // The already-kept file is NOT re-staged: a press that restages it would be
    // a no-op costing one git call.
    expect(state.filePaths).toEqual(['b.ts', 'c.ts'])
  })

  it('turns into the inverse once everything is kept — the control that did not exist before', () => {
    const state = selectAllState([kept('a.ts'), kept('b.ts')], false)
    expect(state).toMatchObject({ checked: true, indeterminate: false, action: 'unkeep' })
    expect(state.filePaths).toEqual(['a.ts', 'b.ts'])
  })

  it('never says anything a person cannot act on — no command, path or config key', () => {
    for (const state of [
      selectAllState([loose('a.ts')], false),
      selectAllState([kept('a.ts'), loose('b.ts')], false),
      selectAllState([kept('a.ts')], false),
    ]) {
      expect(state.title).not.toMatch(/git |--|\.flowconfig|planflow/)
      expect(state.title.length).toBeGreaterThan(0)
    }
  })

  it('counts in the singular when there is one file', () => {
    expect(selectAllState([loose('a.ts')], false).title).toBe('Keep all 1 file')
    expect(selectAllState([kept('a.ts')], false).title).toBe('Stop keeping this file')
  })
})

describe('canRenameReviewBranch — the permission that moved with the control', () => {
  const review = (over: Partial<ThreadChangeReview>): ThreadChangeReview =>
    ({ rootId: '/r', files: [], ownWorktree: true, branch: 'thread/x', state: 'uncommitted', ...over }) as ThreadChangeReview

  it('renames a branch the conversation owns', () => {
    expect(canRenameReviewBranch(review({}))).toBe(true)
  })

  it('refuses when the thread works in the project itself — the branch is shared', () => {
    expect(canRenameReviewBranch(review({ ownWorktree: false }))).toBe(false)
  })

  it('refuses when there is no name yet (a detached checkout)', () => {
    expect(canRenameReviewBranch(review({ branch: null }))).toBe(false)
  })

  it('still renames after a commit — the name is what you check before pushing', () => {
    expect(canRenameReviewBranch(review({ state: 'committed' }))).toBe(true)
  })

  it('has nothing to rename with no review', () => {
    expect(canRenameReviewBranch(null)).toBe(false)
  })
})

describe('commitBoxState — typing the message where the files are', () => {
  const loose = (n: string) => file({ filePath: n, staged: false })
  const kept = (n: string) => file({ filePath: n, staged: true })
  const box = (over: Partial<Parameters<typeof commitBoxState>[0]> = {}) =>
    commitBoxState({ files: [kept('a.ts')], readOnly: false, message: '', generating: false, committing: false, ...over })

  it('hides on committed work and on an empty list', () => {
    expect(box({ readOnly: true }).hidden).toBe(true)
    expect(box({ files: [] }).hidden).toBe(true)
  })

  it('will not commit without a message, however many files are kept', () => {
    expect(box({ message: '   ' }).canCommit).toBe(false)
  })

  it('will not commit with a message but nothing kept', () => {
    expect(box({ files: [loose('a.ts')], message: 'feat: x' }).canCommit).toBe(false)
  })

  it('commits when both halves are there', () => {
    expect(box({ message: 'feat: x' }).canCommit).toBe(true)
  })

  it('cannot write a message for nothing — there is nothing to describe', () => {
    expect(box({ files: [loose('a.ts')] }).canGenerate).toBe(false)
    expect(box({}).canGenerate).toBe(true)
  })

  it('says what it is doing on the button, and stops a second press', () => {
    expect(box({ generating: true }).generateLabel).toBe('Writing…')
    expect(box({ generating: true, message: 'x' }).canCommit).toBe(false)
    expect(box({ committing: true, message: 'x' }).commitLabel).toBe('Committing…')
    expect(box({ committing: true, message: 'x' }).canCommit).toBe(false)
  })

  it('counts what the commit would carry, and goes quiet once written', () => {
    expect(box({ files: [kept('a.ts'), kept('b.ts'), loose('c.ts')] }).keptCount).toBe(2)
    expect(box({ files: [kept('a.ts'), kept('b.ts')] }).hint).toBe('2 files ready — say what changed.')
    expect(box({ files: [kept('a.ts')] }).hint).toBe('1 file ready — say what changed.')
    expect(box({ files: [loose('a.ts')] }).hint).toBe('Tick the files you want in this commit.')
    expect(box({ message: 'feat: x' }).hint).toBeNull()
  })
})

describe('the strip advertises only what the card can show', () => {
  const touched = (n: string) =>
    file({ filePath: n, touchedOnly: true, added: null, deleted: null })
  const changed = (n: string) => file({ filePath: n, added: 3, deleted: 1 })
  const review = (files: ChangeReviewFile[]): ThreadChangeReview =>
    ({ rootId: '/r', files, ownWorktree: true, branch: 'b', state: 'uncommitted' }) as ThreadChangeReview

  // The strip counted every row the review knew about, so a thread that had
  // only OPENED files showed a "Changes" button whose card then said "Nothing
  // changed — N files were opened and left exactly as they were".
  it('stays away when the agent only read files', () => {
    expect(changesStripState(review([touched('a.ts'), touched('b.ts')])).show).toBe(false)
  })

  it('appears as soon as one file really changed', () => {
    expect(changesStripState(review([touched('a.ts'), changed('b.ts')])).show).toBe(true)
  })

  it('stays away for an empty review and for none at all', () => {
    expect(changesStripState(review([])).show).toBe(false)
    expect(changesStripState(null).show).toBe(false)
  })
})
