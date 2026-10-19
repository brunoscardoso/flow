import { SessionBuffer } from './session-buffer'

const size = (s: string): number => s.length

describe('SessionBuffer — bounded, and honest about it', () => {
  it('keeps everything while it fits', () => {
    const buf = new SessionBuffer<string>({ maxRecords: 10, maxBytes: 100 }, size)
    buf.push('a')
    buf.push('bb')
    expect(buf.records()).toEqual(['a', 'bb'])
    expect(buf.loss()).toBeNull()
  })

  it('drops the OLDEST when the record ceiling is hit', () => {
    // A session is a reproduction: the end is the failure, the beginning is
    // setup. When something has to go, the setup goes.
    const buf = new SessionBuffer<string>({ maxRecords: 2, maxBytes: 1000 }, size)
    buf.push('first')
    buf.push('second')
    buf.push('third')
    expect(buf.records()).toEqual(['second', 'third'])
    expect(buf.loss()).toEqual({ droppedRecords: 1, droppedBytes: 5 })
  })

  it('drops on BYTES too — a ceiling in records alone bounds nothing', () => {
    // One 4 MB response body is not one 40-byte log line.
    const buf = new SessionBuffer<string>({ maxRecords: 100, maxBytes: 10 }, size)
    buf.push('aaaaa')
    buf.push('bbbbb')
    buf.push('ccccc')
    expect(buf.records()).toEqual(['bbbbb', 'ccccc'])
    expect(buf.bytes).toBe(10)
    expect(buf.loss()?.droppedBytes).toBe(5)
  })

  it('keeps a record bigger than the whole ceiling, alone', () => {
    // Refusing it would silently drop precisely the biggest body — which on a
    // debugging surface is usually the one somebody wanted.
    const buf = new SessionBuffer<string>({ maxRecords: 5, maxBytes: 4 }, size)
    buf.push('tiny')
    buf.push('an enormous response body')
    expect(buf.records()).toEqual(['an enormous response body'])
    expect(buf.size).toBe(1)
  })

  it('reports nothing lost as NULL, not as zeroes', () => {
    // So the artifact can stay silent about a source that lost nothing, rather
    // than printing a reassuring "0 dropped" on every one of them.
    const buf = new SessionBuffer<string>({ maxRecords: 5, maxBytes: 50 }, size)
    buf.push('fine')
    expect(buf.loss()).toBeNull()
  })

  it('counts everything it dropped, not just the last eviction', () => {
    const buf = new SessionBuffer<string>({ maxRecords: 1, maxBytes: 1000 }, size)
    for (const s of ['aa', 'bb', 'cc', 'dd']) buf.push(s)
    expect(buf.records()).toEqual(['dd'])
    expect(buf.loss()).toEqual({ droppedRecords: 3, droppedBytes: 6 })
  })

  it('treats a negative size as zero rather than growing the budget', () => {
    const buf = new SessionBuffer<string>({ maxRecords: 5, maxBytes: 10 }, () => -5)
    buf.push('x')
    buf.push('y')
    expect(buf.bytes).toBe(0)
    expect(buf.size).toBe(2)
  })
})

describe('take', () => {
  const limits = { maxRecords: 5, maxBytes: 1000 }

  it('removes the oldest first and returns them', () => {
    const buffer = new SessionBuffer<string>(limits, (r) => r.length)
    for (const r of ['a', 'b', 'c']) buffer.push(r)
    expect(buffer.take(2)).toEqual(['a', 'b'])
    expect(buffer.records()).toEqual(['c'])
  })

  it('gives back the bytes it removed', () => {
    const buffer = new SessionBuffer<string>(limits, (r) => r.length)
    buffer.push('aaaa')
    buffer.push('bb')
    buffer.take(1)
    expect(buffer.bytes).toBe(2)
    expect(buffer.size).toBe(1)
  })

  // TAKING IS NOT LOSING. A drain that inflated the loss figure would make
  // every healthy queue report itself as lossy, and `loss()` is what a debug
  // artifact prints for a reader to act on.
  it('does not count as loss', () => {
    const buffer = new SessionBuffer<string>(limits, (r) => r.length)
    buffer.push('a')
    buffer.take(1)
    expect(buffer.loss()).toBeNull()
  })

  it('still reports real eviction after a take', () => {
    const buffer = new SessionBuffer<string>({ maxRecords: 2, maxBytes: 1000 }, (r) => r.length)
    for (const r of ['a', 'b', 'c']) buffer.push(r) // 'a' evicted
    buffer.take(1)
    expect(buffer.loss()).toEqual({ droppedRecords: 1, droppedBytes: 1 })
  })

  it('takes what there is when asked for more, and nothing on empty', () => {
    const buffer = new SessionBuffer<string>(limits, (r) => r.length)
    buffer.push('a')
    expect(buffer.take(10)).toEqual(['a'])
    expect(buffer.take(1)).toEqual([])
    expect(buffer.bytes).toBe(0)
  })
})
