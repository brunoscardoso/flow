import { bannerFor, clampPercent } from './updater'

describe('clampPercent', () => {
  it('rounds a normal percent into an integer', () => {
    expect(clampPercent(42.6)).toBe(43)
  })
  it('clamps out-of-range values into 0–100', () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(150)).toBe(100)
  })
  it('treats NaN as 0 and clamps ±Infinity to the range (feed can glitch mid-stream)', () => {
    expect(clampPercent(Number.NaN)).toBe(0)
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100)
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('bannerFor', () => {
  it('shows nothing while idle, checking, or already up to date', () => {
    expect(bannerFor({ phase: 'idle' })).toBeNull()
    expect(bannerFor({ phase: 'checking' })).toBeNull()
    expect(bannerFor({ phase: 'not-available' })).toBeNull()
  })

  it('offers Download for an available update (dismissible)', () => {
    expect(bannerFor({ phase: 'available', version: '1.3.0' })).toEqual({
      text: 'Flow 1.3.0 is available.',
      action: 'download',
      dismissible: true,
    })
  })

  it('shows progress with no action and no dismiss while downloading', () => {
    expect(bannerFor({ phase: 'downloading', version: '1.3.0', percent: 37 })).toEqual({
      text: 'Downloading update… 37%',
      action: null,
      dismissible: false,
    })
  })

  it('offers Install once downloaded (not dismissible — the update is staged)', () => {
    expect(bannerFor({ phase: 'downloaded', version: '1.3.0' })).toEqual({
      text: 'Flow 1.3.0 is ready — restart to update.',
      action: 'install',
      dismissible: false,
    })
  })

  it('surfaces the error and offers Retry', () => {
    expect(bannerFor({ phase: 'error', message: 'network down' })).toEqual({
      text: 'Update failed: network down',
      action: 'retry',
      dismissible: true,
    })
  })

  it('degrades gracefully when optional fields are missing', () => {
    expect(bannerFor({ phase: 'available' })?.text).toBe('Flow is available.')
    expect(bannerFor({ phase: 'downloading' })?.text).toBe('Downloading update… 0%')
    expect(bannerFor({ phase: 'error' })?.text).toBe('Update failed: unknown error')
  })
})
