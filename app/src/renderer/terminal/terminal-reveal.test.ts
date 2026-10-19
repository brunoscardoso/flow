import { hasLiveVisibleTab, initialTabExited, isLiveVisibleTab } from './terminal-reveal'

describe('isLiveVisibleTab (#439)', () => {
  it('is live for a non-exited tab in scope', () => {
    expect(isLiveVisibleTab({ projectRoot: '/a', exited: false }, '/a')).toBe(true)
    expect(isLiveVisibleTab({ projectRoot: '/a', exited: false }, null)).toBe(true)
  })
  it('is NOT live when the shell has exited, even if in scope', () => {
    expect(isLiveVisibleTab({ projectRoot: '/a', exited: true }, '/a')).toBe(false)
    expect(isLiveVisibleTab({ projectRoot: '/a', exited: true }, null)).toBe(false)
  })
  it('is NOT live when out of the active project scope', () => {
    expect(isLiveVisibleTab({ projectRoot: '/b', exited: false }, '/a')).toBe(false)
  })
})

describe('hasLiveVisibleTab (#439)', () => {
  it('is false when the only in-scope tab has exited — reveal should auto-start', () => {
    expect(hasLiveVisibleTab([{ projectRoot: '/a', exited: true }], '/a')).toBe(false)
    expect(hasLiveVisibleTab([], '/a')).toBe(false)
  })
  it('is true when at least one in-scope tab is live', () => {
    expect(
      hasLiveVisibleTab(
        [
          { projectRoot: '/a', exited: true },
          { projectRoot: '/a', exited: false },
        ],
        '/a',
      ),
    ).toBe(true)
  })
})

describe('initialTabExited (#446)', () => {
  it('restores exit state replayed from terminal:list', () => {
    expect(initialTabExited({ exited: true })).toBe(true)
  })
  it('defaults to live when main omits the flag (backward compatible)', () => {
    expect(initialTabExited({ exited: false })).toBe(false)
    expect(initialTabExited({})).toBe(false)
  })

  it('a reopened window whose only in-scope tab is a replayed-exited shell auto-starts', () => {
    // The #446 end-to-end at the pure level: main marks the dead shell exited →
    // addTab restores it → hasLiveVisibleTab is false → reveal auto-starts a shell.
    const replayed = [{ projectRoot: '/a', exited: true }]
    const scopes = replayed.map((info) => ({
      projectRoot: info.projectRoot,
      exited: initialTabExited(info),
    }))
    expect(hasLiveVisibleTab(scopes, '/a')).toBe(false)
  })
})
