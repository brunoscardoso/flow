import { mayFireArmedAction } from './armed-root'

describe('mayFireArmedAction (#951 fire-time root guard)', () => {
  it('fires when the active root is still the one the action was armed on', () => {
    expect(mayFireArmedAction('/projects/a', '/projects/a')).toBe(true)
  })

  it('refuses when a project switch changed the active root after arming', () => {
    // The #951 scenario: confirm armed in A, fired while B is active.
    expect(mayFireArmedAction('/projects/a', '/projects/b')).toBe(false)
  })

  it('refuses when the active root was cleared after arming', () => {
    expect(mayFireArmedAction('/projects/a', null)).toBe(false)
  })

  it('refuses when the interaction was armed with no known root', () => {
    // Never fire a destructive action whose owning root is unknown — even if
    // the active root is also null (null !== an armed project).
    expect(mayFireArmedAction(null, null)).toBe(false)
    expect(mayFireArmedAction(null, '/projects/a')).toBe(false)
  })
})
