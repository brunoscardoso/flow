import {
  commitFailedToast,
  commitSucceededToast,
  diffFailedToast,
  discardFailedToast,
  discardSucceededToast,
  errorText,
  rejectFailedToast,
} from './review-feedback'

describe('errorText', () => {
  it('reads Error.message, stringifies others, guards [object Object]', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText({})).toBe('Unknown error')
  })
})

describe('commitFailedToast', () => {
  it('surfaces the git error and warns files were not committed', () => {
    const toast = commitFailedToast(new Error('nothing to commit'))
    expect(toast.level).toBe('error')
    expect(toast.title).toBe('Commit failed')
    expect(toast.body).toContain('nothing to commit')
    expect(toast.body).toMatch(/not committed/i)
  })
})

describe('commitSucceededToast (#1433)', () => {
  it('confirms with the group and the landed hash — the #1144 contract', () => {
    const toast = commitSucceededToast('Phase 1 · qa-gate', 'abc1234')
    expect(toast.level).toBe('info')
    expect(toast.title).toBe('Committed')
    expect(toast.body).toBe('Phase 1 · qa-gate · abc1234')
  })
})

describe('discardSucceededToast (#1433)', () => {
  it('names the destroyed count and group so a discard never reads as a commit', () => {
    const toast = discardSucceededToast(3, 'Other changes')
    expect(toast.level).toBe('info')
    expect(toast.title).toBe('Discarded')
    expect(toast.body).toBe('3 changes in Other changes reverted to HEAD.')
  })

  it('singularizes one change', () => {
    expect(discardSucceededToast(1, 'Other changes').body).toBe(
      '1 change in Other changes reverted to HEAD.',
    )
  })
})

describe('rejectFailedToast (#103)', () => {
  it('surfaces the git error and says the file was left unchanged', () => {
    const toast = rejectFailedToast(new Error("Unable to create '.git/index.lock'"))
    expect(toast.level).toBe('error')
    expect(toast.title).toBe('Reject failed')
    expect(toast.body).toContain('index.lock')
    expect(toast.body).toMatch(/left unchanged/i)
  })
})

describe('discardFailedToast (#124)', () => {
  it('reports how many files could not be reverted', () => {
    const toast = discardFailedToast(3)
    expect(toast.level).toBe('error')
    expect(toast.title).toBe('Discard incomplete')
    expect(toast.body).toContain('3 file(s)')
    expect(toast.body).toMatch(/left unchanged/i)
  })
})

describe('diffFailedToast (#659)', () => {
  it('names the file and carries the underlying error', () => {
    const toast = diffFailedToast('src/app.ts', new Error('git diff exploded'))
    expect(toast.level).toBe('error')
    expect(toast.title).toBe('Diff failed')
    expect(toast.body).toContain('src/app.ts')
    expect(toast.body).toContain('git diff exploded')
  })
})
