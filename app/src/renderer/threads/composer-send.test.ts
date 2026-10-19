import { composedPromptFor, composedSendRoute, hasSendableContent } from './composer-send'

describe('hasSendableContent (#430)', () => {
  it('is true for non-whitespace text', () => {
    expect(hasSendableContent('hi', 0, 0)).toBe(true)
  })

  it('is false for empty or whitespace-only text with no chips', () => {
    expect(hasSendableContent('', 0, 0)).toBe(false)
    expect(hasSendableContent('   \n\t', 0, 0)).toBe(false)
  })

  it('is true for a chip-only message (no text)', () => {
    expect(hasSendableContent('', 1, 0)).toBe(true)
    expect(hasSendableContent('   ', 0, 2)).toBe(true)
  })

  it('is true for an image-only message — attachments count as sendable (#541)', () => {
    expect(hasSendableContent('', 0, 0, 1)).toBe(true)
    expect(hasSendableContent('   ', 0, 0, 2)).toBe(true)
  })

  it('is false with no text, chips, or attachments (attachment param defaults to 0)', () => {
    expect(hasSendableContent('', 0, 0)).toBe(false)
    expect(hasSendableContent('', 0, 0, 0)).toBe(false)
  })
})

describe('composedPromptFor — a card-composed message (flow:send-prompt)', () => {
  it('returns the text for the thread this composer shows', () => {
    expect(composedPromptFor({ threadId: 't1', text: '/artifact @flow/discovery/discovery_pay_v1.md' }, 't1')).toBe(
      '/artifact @flow/discovery/discovery_pay_v1.md',
    )
  })

  it('ignores another thread, no thread, and empty or malformed details', () => {
    expect(composedPromptFor({ threadId: 't1', text: 'x' }, 't1')).toBe('x')
    expect(composedPromptFor({ threadId: 't2', text: 'x' }, 't1')).toBeNull()
    expect(composedPromptFor({ threadId: 't1', text: 'x' }, null)).toBeNull()
    expect(composedPromptFor({ threadId: 't1', text: '   ' }, 't1')).toBeNull()
    expect(composedPromptFor({ threadId: 't1' }, 't1')).toBeNull()
    expect(composedPromptFor(null, 't1')).toBeNull()
  })
})

describe('composedSendRoute — the queue rule a typed message follows', () => {
  it('sends when the composer is free and nothing is in flight; queues otherwise', () => {
    expect(composedSendRoute(true, false)).toBe('send')
    expect(composedSendRoute(false, false)).toBe('queue')
    expect(composedSendRoute(true, true)).toBe('queue')
  })
})
