import { ScrollbackBuffer } from './pty-manager'

describe('ScrollbackBuffer memory bound (#171)', () => {
  it('evicts newline-sparse (redraw) output by the char budget, keeping the tail', () => {
    const buf = new ScrollbackBuffer(10_000, 100) // 100-char budget, huge line budget
    // 50 chunks × 20 chars = 1000 chars, ZERO newlines (like a `\r` redraw).
    for (let i = 0; i < 50; i += 1) buf.append('x'.repeat(20))

    expect(buf.charCount).toBeLessThanOrEqual(100)
    expect(buf.snapshot().length).toBeLessThanOrEqual(100)
    expect(buf.snapshot().endsWith('x'.repeat(20))).toBe(true) // most-recent output retained
  })

  it('still evicts by line count when newlines are dense', () => {
    const buf = new ScrollbackBuffer(3, 1_000_000)
    for (let i = 0; i < 10; i += 1) buf.append(`line ${i}\n`)
    expect(buf.lineCount).toBeLessThanOrEqual(3)
  })

  it('trims a single chunk larger than the whole budget to its tail', () => {
    const buf = new ScrollbackBuffer(10_000, 50)
    buf.append('a'.repeat(200)) // one 200-char line, no newline — can't be evicted whole
    expect(buf.charCount).toBe(50)
    expect(buf.snapshot()).toBe('a'.repeat(50))
  })

  it('clear() resets both the char and line budgets', () => {
    const buf = new ScrollbackBuffer(10_000, 100)
    buf.append('x'.repeat(50))
    buf.clear()
    expect(buf.charCount).toBe(0)
    expect(buf.lineCount).toBe(0)
    expect(buf.snapshot()).toBe('')
  })
})
