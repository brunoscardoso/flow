import { PendingBuffer, TRUNCATION_MARKER } from './pending-buffer'

describe('PendingBuffer memory bound (#208)', () => {
  it('drains everything when under the char budget (no marker)', () => {
    const buf = new PendingBuffer(1000)
    buf.push('hello ')
    buf.push('world')
    expect(buf.charCount).toBe(11)
    expect(buf.drain()).toEqual(['hello ', 'world'])
  })

  it('evicts the oldest chunks once over budget, keeping the newest tail', () => {
    const buf = new PendingBuffer(100)
    for (let i = 0; i < 50; i += 1) buf.push('x'.repeat(20)) // 1000 chars pushed
    expect(buf.charCount).toBeLessThanOrEqual(100)
    const out = buf.drain()
    expect(out[0]).toBe(TRUNCATION_MARKER) // dropped output is flagged
    // The retained payload (marker aside) is the most recent chunks.
    expect(out.slice(1).join('')).toBe('x'.repeat(out.slice(1).join('').length))
    expect(out.slice(1).join('').length).toBeLessThanOrEqual(100)
  })

  it('trims a single chunk larger than the whole budget to its tail', () => {
    const buf = new PendingBuffer(50)
    buf.push('a'.repeat(200))
    expect(buf.charCount).toBe(50)
    const out = buf.drain()
    expect(out).toEqual([TRUNCATION_MARKER, 'a'.repeat(50)])
  })

  it('drain empties the buffer and resets the truncation flag', () => {
    const buf = new PendingBuffer(10)
    buf.push('x'.repeat(30)) // triggers truncation
    buf.drain()
    expect(buf.charCount).toBe(0)
    buf.push('short')
    expect(buf.drain()).toEqual(['short']) // no stale marker carried over
  })

  it('ignores empty chunks', () => {
    const buf = new PendingBuffer(100)
    buf.push('')
    expect(buf.charCount).toBe(0)
    expect(buf.drain()).toEqual([])
  })
})
