import {
  TITLEBAR_HEIGHT,
  WINDOWS_CONTROL_BOX_WIDTH,
  windowChromeOptions,
} from './window-chrome'

describe('windowChromeOptions (Windows support, Phase 7)', () => {
  it('keeps the macOS inset traffic lights, with no overlay', () => {
    expect(windowChromeOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset' })
  })

  it('gives Windows a control overlay — hiddenInset there leaves NO caption buttons', () => {
    const options = windowChromeOptions('win32')
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarStyle).not.toBe('hiddenInset')
    expect(options.titleBarOverlay).toEqual({
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      symbolColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      height: TITLEBAR_HEIGHT,
    })
  })

  it('falls back to the standard OS frame elsewhere — never a window with no close button', () => {
    for (const platform of ['linux', 'freebsd', '']) {
      expect(windowChromeOptions(platform)).toEqual({ titleBarStyle: 'default' })
    }
  })

  it('reserves three Chromium caption buttons of width', () => {
    expect(WINDOWS_CONTROL_BOX_WIDTH).toBe(46 * 3)
  })
})
