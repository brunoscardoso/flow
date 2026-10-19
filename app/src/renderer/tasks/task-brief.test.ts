import { canGenerateBrief } from './task-brief'

describe('canGenerateBrief (#362)', () => {
  it('is true when the task has a non-empty description', () => {
    expect(canGenerateBrief({ description: 'Refactor the auth flow', externalKey: null })).toBe(true)
  })

  it('is true when the task has an external issue key (even with no description)', () => {
    expect(canGenerateBrief({ description: null, externalKey: 'PRJ-123' })).toBe(true)
  })

  it('is FALSE for a title-only manual task (no description, no external key) — the dead-click case', () => {
    expect(canGenerateBrief({ description: null, externalKey: null })).toBe(false)
  })

  it('is FALSE for a whitespace-only description', () => {
    expect(canGenerateBrief({ description: '   \n ', externalKey: null })).toBe(false)
  })
})
