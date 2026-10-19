import { MODAL_DISMISS_GUARD_MS, backdropDismissAllowed } from './modal-dismiss-guard'

describe('backdropDismissAllowed (#443)', () => {
  const opened = 10_000

  it('blocks the double-click follow-through (backdrop mousedown right after open)', () => {
    // The second mousedown of a double-click arrives a few ms after open.
    expect(backdropDismissAllowed(opened, opened)).toBe(false)
    expect(backdropDismissAllowed(opened, opened + 5)).toBe(false)
    expect(backdropDismissAllowed(opened, opened + MODAL_DISMISS_GUARD_MS - 1)).toBe(false)
  })

  it('allows a deliberate backdrop dismiss once the guard window has passed', () => {
    expect(backdropDismissAllowed(opened, opened + MODAL_DISMISS_GUARD_MS)).toBe(true)
    expect(backdropDismissAllowed(opened, opened + 2_000)).toBe(true)
  })
})
