import { BoundedOutputCollector } from './output-collector'

describe('BoundedOutputCollector (#271)', () => {
  it('returns the full output verbatim when under the budget', () => {
    const c = new BoundedOutputCollector(1000)
    c.append('hello ')
    c.append('world')
    expect(c.omitted).toBe(0)
    expect(c.result()).toBe('hello world')
  })

  it('caps at the budget and appends a truncation notice with the omitted count', () => {
    const c = new BoundedOutputCollector(10)
    c.append('0123456789ABCDEF') // 16 chars, 6 over
    expect(c.omitted).toBe(6)
    expect(c.result()).toBe('0123456789\n[output truncated: 6 bytes omitted]')
  })

  it('counts overflow across many chunks and stores at most maxChars', () => {
    const c = new BoundedOutputCollector(100)
    for (let i = 0; i < 50; i += 1) c.append('x'.repeat(20)) // 1000 chars pushed
    expect(c.omitted).toBe(900)
    // The stored head is exactly the budget; the notice reports the rest.
    expect(c.result()).toBe('x'.repeat(100) + '\n[output truncated: 900 bytes omitted]')
  })

  it('keeps the HEAD (a chunk that straddles the boundary is split)', () => {
    const c = new BoundedOutputCollector(5)
    c.append('abc')
    c.append('defgh') // only 'de' fits; 'fgh' (3) overflow
    expect(c.omitted).toBe(3)
    expect(c.result()).toBe('abcde\n[output truncated: 3 bytes omitted]')
  })
})
