import { LOG_PAGE_SIZE, commitLogWindow, nextPageCursor } from './commit-log-window'

// #1335: `Commits (100)` printed a capped page size in the same grammar as
// `Changes (N)` and `Staged Changes (N)`, which ARE exact — so it read as a
// fact about the repo. It wasn't, and there was no route to older history.

describe('commitLogWindow (#1335)', () => {
  it('does not claim a count it cannot know', () => {
    // A full page means git had at least that many to give.
    const view = commitLogWindow(LOG_PAGE_SIZE)
    expect(view.label).toBe('Commits · latest 100')
    expect(view.label).not.toContain('(100)')
    expect(view.canLoadOlder).toBe(true)
  })

  it('states an exact count once the history genuinely ends', () => {
    // A SHORT page is the end — then the number is a fact, and it reads like
    // its exact siblings.
    const view = commitLogWindow(42)
    expect(view.label).toBe('Commits (42)')
    expect(view.canLoadOlder).toBe(false)
  })

  it('keeps saying "latest" while every page comes back full', () => {
    expect(commitLogWindow(200).label).toBe('Commits · latest 200')
    expect(commitLogWindow(200).canLoadOlder).toBe(true)
    // …and stops the moment one doesn't.
    expect(commitLogWindow(247).canLoadOlder).toBe(false)
  })

  it('is exact for an empty repo', () => {
    expect(commitLogWindow(0)).toEqual({ label: 'Commits (0)', canLoadOlder: false })
  })

  it('handles a repo shorter than one page', () => {
    expect(commitLogWindow(3).label).toBe('Commits (3)')
  })

  // #1438: the page-boundary rule is an INFERENCE ("a full page means there may
  // be more"). A repo whose history is exactly N pages long sits on that
  // boundary forever and was offered a button that could only ask git for
  // nothing. Having watched git run out is a fact, and it outranks the guess.
  describe('once git has been seen to run out (#1438)', () => {
    it('retires the affordance on an exact-page-multiple history', () => {
      expect(commitLogWindow(100).canLoadOlder).toBe(true) // before the click
      const view = commitLogWindow(100, LOG_PAGE_SIZE, true) // after it found nothing
      expect(view.canLoadOlder).toBe(false)
      expect(view.label).toBe('Commits (100)')
    })

    it('turns "latest N" into an exact count, because now it is one', () => {
      expect(commitLogWindow(200, LOG_PAGE_SIZE, true).label).toBe('Commits (200)')
    })

    it('changes nothing for a history that already ended short', () => {
      expect(commitLogWindow(247, LOG_PAGE_SIZE, true)).toEqual(
        commitLogWindow(247, LOG_PAGE_SIZE, false),
      )
    })

    it('still reports an empty repo as empty', () => {
      expect(commitLogWindow(0, LOG_PAGE_SIZE, true)).toEqual({
        label: 'Commits (0)',
        canLoadOlder: false,
      })
    })
  })
})

describe('nextPageCursor (#1335)', () => {
  it('pages from the OLDEST loaded commit', () => {
    // GitManager.log pages with `--skip=1 <rev>`, so the oldest hash returns
    // what precedes it.
    expect(nextPageCursor([{ hash: 'aaa' }, { hash: 'bbb' }])).toBe('bbb')
  })

  it('is null with nothing loaded', () => {
    expect(nextPageCursor([])).toBeNull()
  })
})
