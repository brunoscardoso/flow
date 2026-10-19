import { isProjectSwitch } from './project-switch'

describe('isProjectSwitch (#281)', () => {
  it('is true when the active root changes between two projects', () => {
    expect(isProjectSwitch('/repo/a', '/repo/b')).toBe(true)
  })

  it('is false for the same root — a background refresh must NOT clear drafts', () => {
    expect(isProjectSwitch('/repo/a', '/repo/a')).toBe(false)
  })

  it('treats the first selection (from null) as a switch', () => {
    expect(isProjectSwitch(null, '/repo/a')).toBe(true)
  })

  it('is false when both are null', () => {
    expect(isProjectSwitch(null, null)).toBe(false)
  })
})
