import { reviewEmptyMessage } from './review-empty'

// #1332: one empty state served three materially different situations, and
// the one it chose — "No changes to review" — is the most reassuring sentence
// available for the two that are anything but.

describe('reviewEmptyMessage (#1332)', () => {
  it('says a clean tree only when the tree is genuinely clean', () => {
    expect(reviewEmptyMessage({ hasProject: true, gitState: 'ok' })).toBe('No changes to review')
  })

  it('does not claim a clean tree with no project open', () => {
    // The Changes view says exactly this for the same state.
    expect(reviewEmptyMessage({ hasProject: false })).toBe('No project open')
  })

  it('does not claim a clean tree for a folder git cannot read', () => {
    expect(reviewEmptyMessage({ hasProject: true, gitState: 'no-repo' })).toBe(
      'Not a git repository',
    )
  })

  it('lets no-project win over the git state, which is meaningless without one', () => {
    expect(reviewEmptyMessage({ hasProject: false, gitState: 'no-repo' })).toBe('No project open')
  })

  it('treats an older payload without gitState as ok — the previous behaviour', () => {
    expect(reviewEmptyMessage({ hasProject: true })).toBe('No changes to review')
  })
})
