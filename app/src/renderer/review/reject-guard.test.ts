import { rejectGuard } from './reject-guard'

describe('rejectGuard (#397)', () => {
  it('allows the reject when a thread is active', () => {
    expect(rejectGuard(true)).toEqual({ allowed: true, blockedReason: null })
  })

  it('blocks the reject with a reason when no thread is active (no silent data loss)', () => {
    const guard = rejectGuard(false)
    expect(guard.allowed).toBe(false)
    expect(guard.blockedReason).toMatch(/thread/i)
    expect(guard.blockedReason).toMatch(/nothing was reverted/i)
  })
})
