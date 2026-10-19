import {
  DEFAULT_MODEL_ROUTING,
  isRoutableModel,
  parseModelRouting,
  resolveAutoModel,
  ROUTABLE_MODELS,
} from './model-routing'

describe('resolveAutoModel (#129)', () => {
  it('routes each effort to its configured model', () => {
    const routing = { low: 'haiku', medium: 'opus', high: 'opus' } as const
    expect(resolveAutoModel('low', routing)).toBe('haiku')
    expect(resolveAutoModel('medium', routing)).toBe('opus')
    expect(resolveAutoModel('high', routing)).toBe('opus')
  })

  it('falls back to the suggested default for a missing/invalid entry', () => {
    expect(resolveAutoModel('medium', {})).toBe(DEFAULT_MODEL_ROUTING.medium)
    expect(resolveAutoModel('high', { high: 'nope' } as never)).toBe(DEFAULT_MODEL_ROUTING.high)
    expect(resolveAutoModel('low', null)).toBe(DEFAULT_MODEL_ROUTING.low)
  })
})

describe('parseModelRouting', () => {
  it('returns the defaults for empty / unparseable input', () => {
    expect(parseModelRouting(null)).toEqual(DEFAULT_MODEL_ROUTING)
    expect(parseModelRouting('')).toEqual(DEFAULT_MODEL_ROUTING)
    expect(parseModelRouting('{ not json')).toEqual(DEFAULT_MODEL_ROUTING)
  })

  it('keeps valid fields and defaults the rest', () => {
    expect(parseModelRouting(JSON.stringify({ low: 'sonnet', high: 'bogus' }))).toEqual({
      low: 'sonnet',
      medium: DEFAULT_MODEL_ROUTING.medium,
      high: DEFAULT_MODEL_ROUTING.high,
    })
  })

  it('round-trips a full valid map', () => {
    const routing = { low: 'haiku', medium: 'haiku', high: 'sonnet' } as const
    expect(parseModelRouting(JSON.stringify(routing))).toEqual(routing)
  })
})

describe('a model added to the list is routable everywhere it is offered', () => {
  it('accepts fable as an effort target', () => {
    expect(isRoutableModel('fable')).toBe(true)
    expect(parseModelRouting('{"low":"haiku","medium":"sonnet","high":"fable"}').high).toBe('fable')
  })

  it('leaves the suggested defaults exactly where they were', () => {
    // Offering a model is new capability; changing what Auto ALREADY picks would
    // silently move every existing thread onto a different model.
    expect(DEFAULT_MODEL_ROUTING).toEqual({ low: 'haiku', medium: 'sonnet', high: 'opus' })
    expect(parseModelRouting(null)).toEqual(DEFAULT_MODEL_ROUTING)
  })

  it('still refuses a model nobody offers', () => {
    expect(isRoutableModel('gpt-5')).toBe(false)
    expect(isRoutableModel('auto')).toBe(false)
    expect(parseModelRouting('{"high":"gpt-5"}').high).toBe(DEFAULT_MODEL_ROUTING.high)
  })

  it('keeps the guard and the offered list as ONE list', () => {
    // Three files used to spell these names separately; a fourth model added to
    // one of them would be offered by a control that then refused to save it.
    for (const model of ROUTABLE_MODELS) expect(isRoutableModel(model)).toBe(true)
  })
})
