import { nextRunKey, parseRunKey, runKeyPrefix, runTitle, summarizeAim } from './loop-run-key'

const AIM =
  'look for everything related to tenant id or tenant alias on the project, try find gaps between then, I mean things that can break the plataform'

describe('runKeyPrefix', () => {
  it('is T + the project initial + L', () => {
    expect(runKeyPrefix('orbit-app')).toBe('TOL')
    expect(runKeyPrefix('plan-flow')).toBe('TPL')
  })

  it('takes the first LETTER, not the first character', () => {
    expect(runKeyPrefix('2-orbit')).toBe('TOL')
    expect(runKeyPrefix('.hidden')).toBe('THL')
  })

  it('still answers for a name with no letters at all', () => {
    expect(runKeyPrefix('42')).toBe('TXL')
  })
})

describe('nextRunKey', () => {
  it('starts at 001', () => {
    expect(nextRunKey('orbit-app', [])).toBe('TOL-001')
  })

  it('counts from the HIGHEST key, not from how many there are', () => {
    // A deleted run must not hand its number to the next one: two runs
    // answering to the same key is the confusion a key exists to avoid.
    expect(nextRunKey('orbit-app', ['TOL-001', 'TOL-004'])).toBe('TOL-005')
  })

  it('ignores another project’s keys and anything that is not a key', () => {
    expect(nextRunKey('orbit-app', ['TPL-009', 'nonsense', ''])).toBe('TOL-001')
  })

  it('keeps counting past three digits without renaming what came before', () => {
    expect(nextRunKey('orbit-app', ['TOL-999'])).toBe('TOL-1000')
  })
})

describe('parseRunKey', () => {
  it('reads a key and refuses a non-key', () => {
    expect(parseRunKey('TOL-007')).toEqual({ prefix: 'TOL', number: 7 })
    expect(parseRunKey('  TOL-007  ')).toEqual({ prefix: 'TOL', number: 7 })
    expect(parseRunKey('TOL007')).toBeNull()
    expect(parseRunKey('a paragraph someone typed')).toBeNull()
  })
})

describe('summarizeAim', () => {
  it('cuts at the writer’s own punctuation', () => {
    expect(summarizeAim(AIM)).toBe(
      'look for everything related to tenant id or tenant alias on the project',
    )
  })

  it('leaves a short aim exactly as typed', () => {
    expect(summarizeAim('find flaky tests')).toBe('find flaky tests')
    expect(summarizeAim('  spaced   out  ')).toBe('spaced out')
  })

  it('pulls in the next clause when the first is too short to be a summary', () => {
    const text = `tenant ids, and every alias that is written beside one, everywhere in the platform`
    expect(summarizeAim(text)).toBe('tenant ids, and every alias that is written beside one')
  })

  it('never cuts a word in half when there is no punctuation to cut at', () => {
    const text = `a${' word'.repeat(40)}`
    const summary = summarizeAim(text)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(74)
    expect(summary).not.toMatch(/wor…$/)
  })

  it('is empty for an empty aim (a run with no sentence on it)', () => {
    expect(summarizeAim('   ')).toBe('')
  })
})

describe('runTitle', () => {
  it('is the key, then what it is about', () => {
    expect(runTitle('TOL-001', 'find flaky tests')).toBe('TOL-001 · find flaky tests')
  })

  it('is the key ALONE when there is no aim — never a dangling separator', () => {
    expect(runTitle('TOL-001', '')).toBe('TOL-001')
  })
})
