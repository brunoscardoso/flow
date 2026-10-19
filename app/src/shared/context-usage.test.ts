import {
  contextMeterLabel,
  formatUsed,
  formatWindow,
  readContext,
  FILLING_AT,
  NEARLY_FULL_AT,
} from './context-usage'

describe('readContext', () => {
  // THE POINT OF THE WHOLE FEATURE: a denominator that belongs to the model
  // that answered, never a constant. The hook this replaces measured ~1M
  // conversations against a hardcoded 200K and printed "450% full" (#1956).
  it('reads a fraction of the window it was given', () => {
    const reading = readContext({ totalTokens: 742_100, maxTokens: 1_000_000, model: 'claude-opus-5' , canShorten: true })
    expect(reading).toMatchObject({ percentage: 74, pressure: 'filling', label: '74% of 1M' })
  })

  it('calls the same token count healthy against a larger window', () => {
    // 150k is 75% of a 200K window and 15% of a 1M one. Nothing about the
    // conversation changed; only which model is holding it.
    expect(readContext({ totalTokens: 150_000, maxTokens: 200_000, model: 'm' , canShorten: true })?.pressure).toBe('filling')
    expect(readContext({ totalTokens: 150_000, maxTokens: 1_000_000, model: 'm' , canShorten: true })?.pressure).toBe('healthy')
  })

  describe('returns null — the honest no-reading', () => {
    // Null is rendered as today's line: token counts, no bar, no percentage.
    // Anything else invents a denominator and dresses it as a measurement.
    it('for a provider that reports no window', () => {
      expect(readContext({ totalTokens: 88_000, maxTokens: 0, model: 'some-model' , canShorten: true })).toBeNull()
    })

    it('for a window that is not a usable number', () => {
      expect(readContext({ totalTokens: 1, maxTokens: Number.NaN, model: null , canShorten: true })).toBeNull()
      expect(readContext({ totalTokens: 1, maxTokens: -1, model: null , canShorten: true })).toBeNull()
    })

    it('for no snapshot at all — no session, or a runtime with no such API', () => {
      expect(readContext(null)).toBeNull()
      expect(readContext(undefined)).toBeNull()
    })

    it('for a nonsense total', () => {
      expect(readContext({ totalTokens: Number.NaN, maxTokens: 1_000, model: null , canShorten: true })).toBeNull()
      expect(readContext({ totalTokens: -5, maxTokens: 1_000, model: null , canShorten: true })).toBeNull()
    })
  })

  describe('pressure boundaries', () => {
    const at = (ratio: number) => readContext({ totalTokens: ratio * 1_000_000, maxTokens: 1_000_000, model: null , canShorten: true })

    it('crosses exactly at the published thresholds', () => {
      expect(at(FILLING_AT - 0.001)?.pressure).toBe('healthy')
      expect(at(FILLING_AT)?.pressure).toBe('filling')
      expect(at(NEARLY_FULL_AT - 0.001)?.pressure).toBe('filling')
      expect(at(NEARLY_FULL_AT)?.pressure).toBe('nearly-full')
    })

    it('reports an empty conversation as healthy, not as a missing reading', () => {
      // Zero is a measurement. Only an unknown WINDOW is a missing reading.
      expect(readContext({ totalTokens: 0, maxTokens: 1_000_000, model: null , canShorten: true })).toMatchObject({
        percentage: 0,
        pressure: 'healthy',
      })
    })
  })

  it('clamps the displayed percentage over the limit, without hiding the state', () => {
    // The SDK reports over-limit as a real condition. 112% in a 64px bar reads
    // as a broken bar; the pressure still says what is going on.
    const reading = readContext({ totalTokens: 1_120_000, maxTokens: 1_000_000, model: null , canShorten: true })
    expect(reading?.percentage).toBe(100)
    expect(reading?.pressure).toBe('nearly-full')
    expect(reading?.totalTokens).toBe(1_120_000) // the real number survives for the panel
  })

  it('keeps the model when there is one, and null when there is not', () => {
    expect(readContext({ totalTokens: 1, maxTokens: 10, model: 'claude-opus-5' , canShorten: true })?.model).toBe('claude-opus-5')
    expect(readContext({ totalTokens: 1, maxTokens: 10, model: '' , canShorten: true })?.model).toBeNull()
  })
})

describe('canShorten', () => {
  // ASKED of the runtime, never assumed. A button that sends a command the
  // session does not have is a control that silently does nothing.
  it('carries the runtime’s answer through to the reading', () => {
    expect(readContext({ totalTokens: 1, maxTokens: 10, model: null, canShorten: true })?.canShorten).toBe(true)
    expect(readContext({ totalTokens: 1, maxTokens: 10, model: null, canShorten: false })?.canShorten).toBe(false)
  })

  it('treats anything but a definite yes as no', () => {
    // Unknown is not yes: an older CLI that cannot answer gets no button.
    const vague = { totalTokens: 1, maxTokens: 10, model: null } as never
    expect(readContext(vague)?.canShorten).toBe(false)
  })
})

describe('formatWindow', () => {
  it('says a window the round way it is spoken', () => {
    expect(formatWindow(1_000_000)).toBe('1M')
    expect(formatWindow(1_500_000)).toBe('1.5M')
    expect(formatWindow(200_000)).toBe('200K')
    expect(formatWindow(64_000)).toBe('64K')
    expect(formatWindow(900)).toBe('900')
  })
})

describe('formatUsed', () => {
  it('keeps small counts exact and abbreviates large ones', () => {
    expect(formatUsed(640)).toBe('640')
    expect(formatUsed(112_400)).toBe('112.4k')
    expect(formatUsed(1_120_000)).toBe('1.12M')
  })

  it('never prints a negative or fractional token count', () => {
    expect(formatUsed(-3)).toBe('0')
    expect(formatUsed(12.7)).toBe('13')
  })
})

describe('contextMeterLabel', () => {
  it('names the control for a screen reader, in words and not a bar', () => {
    const reading = readContext({ totalTokens: 921_600, maxTokens: 1_000_000, model: 'claude-opus-5' , canShorten: true })!
    expect(contextMeterLabel(reading)).toBe(
      'Context 92% full — 921.6k of 1M tokens. Open context controls.',
    )
  })

  it('does not promise controls at rest', () => {
    const reading = readContext({ totalTokens: 10_000, maxTokens: 1_000_000, model: null , canShorten: true })!
    expect(contextMeterLabel(reading)).toBe('Context 1% full — 10.0k of 1M tokens.')
  })
})
