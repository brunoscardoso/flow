import {
  closeOtherSettingsOverlays,
  registerSettingsOverlay,
  registeredSettingsOverlays,
} from './settings-overlay-stack'

// #1395: the three settings-family dialogs share a class and a z-index and are
// appended to <body> in a fixed order, so the one opened LAST painted
// UNDERNEATH the ones created before it. ⌘, over Flow settings moved focus
// into a dialog the user could not see.

describe('settings overlay stack (#1395)', () => {
  afterEach(() => {
    for (const name of registeredSettingsOverlays()) {
      // Unregister via a fresh registration then its own disposer.
      registerSettingsOverlay(name, () => undefined)()
    }
  })

  it('closes the siblings when one opens', () => {
    const closed: string[] = []
    registerSettingsOverlay('settings', () => closed.push('settings'))
    registerSettingsOverlay('flow', () => closed.push('flow'))
    registerSettingsOverlay('integrations', () => closed.push('integrations'))

    closeOtherSettingsOverlays('flow')

    expect(closed.sort()).toEqual(['integrations', 'settings'])
  })

  it('never closes the one being opened', () => {
    const closed: string[] = []
    registerSettingsOverlay('settings', () => closed.push('settings'))
    closeOtherSettingsOverlays('settings')
    expect(closed).toEqual([])
  })

  it('does not let one stuck sibling block the open', () => {
    // Refusing to open the dialog the user asked for, because an unrelated one
    // threw while closing, would be a worse failure than the stacking.
    const closed: string[] = []
    registerSettingsOverlay('broken', () => {
      throw new Error('nope')
    })
    registerSettingsOverlay('integrations', () => closed.push('integrations'))

    expect(() => closeOtherSettingsOverlays('settings')).not.toThrow()
    expect(closed).toEqual(['integrations'])
  })

  it('replaces a re-registered name rather than stacking closers', () => {
    const calls: string[] = []
    registerSettingsOverlay('settings', () => calls.push('first'))
    registerSettingsOverlay('settings', () => calls.push('second'))
    closeOtherSettingsOverlays('other')
    expect(calls).toEqual(['second'])
  })

  it('unregisters only its own entry', () => {
    const dispose = registerSettingsOverlay('settings', () => undefined)
    registerSettingsOverlay('settings', () => undefined)
    dispose() // the FIRST registration's disposer — its entry is already gone
    expect(registeredSettingsOverlays()).toContain('settings')
  })
})
