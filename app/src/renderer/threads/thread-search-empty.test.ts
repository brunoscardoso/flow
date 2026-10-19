import { emptySidebarMessage } from './thread-search-empty'

describe('emptySidebarMessage (#326)', () => {
  it('names the query in a search empty state so the user knows it matched nothing', () => {
    expect(emptySidebarMessage(true, 'zzz-nonexistent')).toBe('No threads match “zzz-nonexistent”')
  })

  it('falls back to the first-run hint when not searching', () => {
    expect(emptySidebarMessage(false, '')).toBe('No threads yet')
  })
})

describe('emptySidebarMessage (#978)', () => {
  it('names the real blocker when no project is open', () => {
    expect(emptySidebarMessage(false, '', false)).toBe(
      'Open a project to start — Add project… in the Workspace menu',
    )
  })

  it('keeps "No threads yet" for an open project with zero threads', () => {
    expect(emptySidebarMessage(false, '', true)).toBe('No threads yet')
  })

  it('search feedback wins over the no-project branch (query names the miss)', () => {
    expect(emptySidebarMessage(true, 'auth', false)).toBe('No threads match “auth”')
  })
})
