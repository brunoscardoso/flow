import { formatConsoleArgs } from './console-format'

describe('formatConsoleArgs', () => {
  it('joins plain arguments with a space, as a console does', () => {
    expect(formatConsoleArgs(['loaded', '3', 'items'])).toBe('loaded 3 items')
  })

  it('CONSUMES %c and drops its style, instead of printing both', () => {
    // The exact shape Electron's own security warning takes — and what the
    // drawer showed: the directive raw, the CSS tacked on the end.
    expect(
      formatConsoleArgs([
        '%cElectron Security Warning%c\n\nThis renderer has Node integration',
        'font-weight: bold;',
        'font-weight: normal;',
      ]),
    ).toBe('Electron Security Warning\n\nThis renderer has Node integration')
  })

  it('substitutes %s and %d', () => {
    expect(formatConsoleArgs(['%s took %dms', 'save', '42'])).toBe('save took 42ms')
  })

  it('treats %% as a literal percent', () => {
    expect(formatConsoleArgs(['100%% done'])).toBe('100% done')
  })

  it('prints a directive with no argument as itself', () => {
    // Which is what a console does, and a truer reading than an empty gap.
    expect(formatConsoleArgs(['%s and %s', 'one'])).toBe('one and %s')
  })

  it('appends arguments the directives did not claim', () => {
    // A page passing more than it formatted still means them to be seen.
    expect(formatConsoleArgs(['%s:', 'error', 'details', 'here'])).toBe('error: details here')
  })

  it('leaves an unknown directive alone', () => {
    expect(formatConsoleArgs(['50%x of it'])).toBe('50%x of it')
  })

  it('handles a trailing bare percent', () => {
    expect(formatConsoleArgs(['%s%', 'x'])).toBe('x%')
  })

  it('is empty for no arguments', () => {
    expect(formatConsoleArgs([])).toBe('')
  })

  it('does not treat a message that merely CONTAINS a percent as formatted', () => {
    expect(formatConsoleArgs(['disk 80% full', 'extra'])).toBe('disk 80% full extra')
  })
})
