import { describe, expect, it } from '@jest/globals'

import { commitMessage } from './sync-timing'

describe('commitMessage', () => {
  it('is one bounded line under the Flow prefix', () => {
    expect(commitMessage('turn in app')).toBe('Flow: turn in app')
    expect(commitMessage('a\nb\r\tc')).toBe('Flow: a b c')
    expect(commitMessage('   ')).toBe('Flow: changes')
    expect(commitMessage('x'.repeat(200)).length).toBeLessThanOrEqual('Flow: '.length + 72)
  })
})
