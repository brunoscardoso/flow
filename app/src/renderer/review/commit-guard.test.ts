import { canDispatchCommit } from './commit-guard'

describe('canDispatchCommit (#434)', () => {
  it('allows a commit when none is in flight for the root', () => {
    expect(canDispatchCommit(new Set(), '/repo/a')).toBe(true)
    expect(canDispatchCommit(new Set(['/repo/b']), '/repo/a')).toBe(true)
  })

  it('drops a redundant commit while one is in flight for that root', () => {
    expect(canDispatchCommit(new Set(['/repo/a']), '/repo/a')).toBe(false)
  })
})
