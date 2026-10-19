import { needsOnboarding } from './first-run'

describe('needsOnboarding (#48 first-run gate)', () => {
  it('shows when no account is connected', () => {
    expect(needsOnboarding({ accountCount: 0, rootCount: 3, completed: false })).toBe(true)
  })

  it('shows when no project is open', () => {
    expect(needsOnboarding({ accountCount: 1, rootCount: 0, completed: false })).toBe(true)
  })

  it('shows when both are missing', () => {
    expect(needsOnboarding({ accountCount: 0, rootCount: 0, completed: false })).toBe(true)
  })

  it('does not show once essentials are present', () => {
    expect(needsOnboarding({ accountCount: 1, rootCount: 1, completed: false })).toBe(false)
  })

  it('treats the Workspace as no essential: a project with its essentials does not re-open the wizard', () => {
    // Positive first: a missing essential DOES show it…
    expect(needsOnboarding({ accountCount: 0, rootCount: 1, completed: false })).toBe(true)
    // …and nothing about Workspaces is an essential (the gate reads no such input).
    expect(needsOnboarding({ accountCount: 1, rootCount: 1, completed: false })).toBe(false)
    expect(Object.keys({ accountCount: 1, rootCount: 1, completed: false } satisfies Parameters<typeof needsOnboarding>[0])).toEqual([
      'accountCount',
      'rootCount',
      'completed',
    ])
  })

  it('never shows after completion, even if a prerequisite is later removed', () => {
    expect(needsOnboarding({ accountCount: 0, rootCount: 0, completed: true })).toBe(false)
  })
})
