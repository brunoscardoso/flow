import { isLatestRender } from './render-guard'

describe('isLatestRender (#308)', () => {
  it('lets the most recent render commit to the DOM', () => {
    expect(isLatestRender(3, 3)).toBe(true)
  })

  it('bails a render that a newer one superseded during its awaits', () => {
    // Render A (gen 1) yields on an await; render B (gen 2) starts → A must not
    // touch #body when it resumes, or its sections duplicate B's.
    expect(isLatestRender(1, 2)).toBe(false)
  })

  it('models the guard across successive interleaves (only the latest wins)', () => {
    let latest = 0
    const a = ++latest // render A → gen 1
    const b = ++latest // render B → gen 2 (supersedes A)
    expect(isLatestRender(a, latest)).toBe(false)
    expect(isLatestRender(b, latest)).toBe(true)
  })
})
