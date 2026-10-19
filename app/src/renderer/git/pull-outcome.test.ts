import { pullToast } from './pull-outcome'

// #1336: Pull reported "Pulled / Up to date" byte-identically whether it
// fast-forwarded 20 commits or did nothing — and "Up to date" is an outright
// false claim about the first case, not merely an uninformative one.

describe('pullToast (#1336)', () => {
  it('says how much arrived', () => {
    expect(pullToast({ conflicted: false, received: 2, branch: 'main' })).toMatchObject({
      title: 'Pulled',
      body: '2 new commits on main.',
    })
  })

  it('singularises', () => {
    expect(pullToast({ conflicted: false, received: 1, branch: 'main' }).body).toContain(
      '1 new commit on main.',
    )
  })

  it('distinguishes "nothing arrived" from "something did"', () => {
    const nothing = pullToast({ conflicted: false, received: 0, branch: 'main' })
    const something = pullToast({ conflicted: false, received: 3, branch: 'main' })
    expect(nothing.title).toBe('Already up to date')
    expect(nothing.body).not.toBe(something.body)
  })

  it('never claims zero when it could not measure', () => {
    // An unborn branch or unreadable HEAD is UNKNOWN. Reporting it as "up to
    // date" is exactly the false claim this fixes.
    const unknown = pullToast({ conflicted: false, received: null, branch: 'main' })
    expect(unknown.body).toContain('check the log')
    expect(unknown.title).not.toBe('Already up to date')
  })

  it('keeps the conflict message, which was already honest', () => {
    expect(pullToast({ conflicted: true, received: null, branch: 'main' }).title).toBe(
      'Pull has conflicts',
    )
  })

  it('omits the branch when git could not name one', () => {
    expect(pullToast({ conflicted: false, received: 2, branch: '' }).body).toBe('2 new commits.')
  })
})
