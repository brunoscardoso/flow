import {
  MAC_TRAFFIC_LIGHT_WIDTH,
  WINDOWS_CONTROL_BOX_WIDTH,
  currentPlatform,
  isCaptureAffordanceVisible,
  titlebarInsets,
} from './platform-affordances'

describe('titlebarInsets (Windows support, Phase 7)', () => {
  it('reserves the traffic lights on the LEFT for macOS, zoom-divided (#1352)', () => {
    expect(titlebarInsets('darwin')).toEqual({
      left: `calc(${MAC_TRAFFIC_LIGHT_WIDTH}px / var(--fl-zoom, 1))`,
      right: 'var(--fl-space-sm)',
    })
  })

  it('reserves the control box on the RIGHT for Windows, zoom-divided', () => {
    expect(titlebarInsets('win32')).toEqual({
      left: 'var(--fl-space-sm)',
      right: `calc(${WINDOWS_CONTROL_BOX_WIDTH}px / var(--fl-zoom, 1))`,
    })
  })

  it('never gives Windows the macOS left reserve — that was dead space', () => {
    expect(titlebarInsets('win32').left).not.toContain(`${MAC_TRAFFIC_LIGHT_WIDTH}px`)
  })

  it('reserves neither edge where the OS draws a standard frame', () => {
    expect(titlebarInsets('linux')).toEqual({
      left: 'var(--fl-space-sm)',
      right: 'var(--fl-space-sm)',
    })
  })

  it('accepts legacy navigator.platform strings as well as process.platform', () => {
    expect(titlebarInsets('MacIntel')).toEqual(titlebarInsets('darwin'))
    expect(titlebarInsets('Win32')).toEqual(titlebarInsets('win32'))
  })
})

describe('isCaptureAffordanceVisible (#456)', () => {
  it('shows the screenshot button on macOS only', () => {
    expect(isCaptureAffordanceVisible('darwin')).toBe(true)
    expect(isCaptureAffordanceVisible('MacIntel')).toBe(true)
  })

  it('HIDES it everywhere else rather than failing on click', () => {
    for (const platform of ['win32', 'Win32', 'linux', '']) {
      expect(isCaptureAffordanceVisible(platform)).toBe(false)
    }
  })
})

describe('currentPlatform', () => {
  const bridge = globalThis as { flowPlatform?: string }

  afterEach(() => {
    delete bridge.flowPlatform
  })

  it('prefers the preload bridge value over the navigator sniff', () => {
    bridge.flowPlatform = 'win32'
    expect(currentPlatform()).toBe('win32')
  })

  it('returns a string when neither source exists', () => {
    expect(typeof currentPlatform()).toBe('string')
  })
})
