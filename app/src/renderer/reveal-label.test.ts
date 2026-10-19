import { currentRevealPlatform, revealLabel, revealLabelFor } from './reveal-label'

describe('revealLabelFor', () => {
  it('maps Node process.platform values', () => {
    expect(revealLabelFor('darwin')).toBe('Reveal in Finder')
    expect(revealLabelFor('win32')).toBe('Reveal in Explorer')
    expect(revealLabelFor('linux')).toBe('Reveal in file manager')
  })

  it('maps legacy navigator.platform values', () => {
    expect(revealLabelFor('MacIntel')).toBe('Reveal in Finder')
    expect(revealLabelFor('Win32')).toBe('Reveal in Explorer')
    expect(revealLabelFor('Linux x86_64')).toBe('Reveal in file manager')
  })

  it('falls back to the generic label for unknown platforms', () => {
    expect(revealLabelFor('')).toBe('Reveal in file manager')
    expect(revealLabelFor('freebsd')).toBe('Reveal in file manager')
  })
})

describe('currentRevealPlatform', () => {
  const holder = globalThis as { flowPlatform?: string }
  afterEach(() => {
    delete holder.flowPlatform
  })

  it('prefers the authoritative bridge value', () => {
    holder.flowPlatform = 'win32'
    expect(currentRevealPlatform()).toBe('win32')
    expect(revealLabel()).toBe('Reveal in Explorer')
  })

  it('returns a string when no bridge value is present', () => {
    delete holder.flowPlatform
    expect(typeof currentRevealPlatform()).toBe('string')
  })
})
