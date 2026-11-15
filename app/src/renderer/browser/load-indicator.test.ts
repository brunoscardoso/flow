import { loadIndicator } from './load-indicator'

describe('loadIndicator', () => {
  it('keeps a page on screen during the next load and shows the bar', () => {
    expect(loadIndicator(true)).toBe('bar')
  })

  it('shows the loading screen when there is no page beneath it', () => {
    expect(loadIndicator(false)).toBe('screen')
  })
})
