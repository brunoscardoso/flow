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

describe('composedSendRoute — the one rule a typed and a composed send follow', () => {
  it('sends a new turn when the composer is free and nothing is in flight', () => {
    for (const status of ['idle', 'done', 'failed'] as const) {
      expect(composedSendRoute({ status, sending: false, provider: 'claude' })).toBe('send')
      expect(composedSendRoute({ status, sending: false, provider: 'copilot' })).toBe('send')
      expect(composedSendRoute({ status, sending: false, provider: null })).toBe('send')
    }
  })

  it('injects into the live turn of a working Claude thread', () => {
    expect(composedSendRoute({ status: 'working', sending: false, provider: 'claude' })).toBe('inject')
  })

  it('queues on a turn parked on a decision, even for Claude (#1470)', () => {
    // State the positive first (allowed-pattern #28): the same thread injects
    // while it is working, so the queue below is the parked-turn rule at work.
    expect(composedSendRoute({ status: 'working', sending: false, provider: 'claude' })).toBe('inject')
    expect(composedSendRoute({ status: 'needs-decision', sending: false, provider: 'claude' })).toBe('queue')
    expect(composedSendRoute({ status: 'blocked', sending: false, provider: 'claude' })).toBe('queue')
  })

  it('queues while a send is still in flight, whatever the status', () => {
    expect(composedSendRoute({ status: 'working', sending: true, provider: 'claude' })).toBe('queue')
    expect(composedSendRoute({ status: 'idle', sending: true, provider: 'claude' })).toBe('queue')
  })

  it('keeps the queue for a working Copilot or Codex thread, and for an unknown runtime', () => {
    expect(composedSendRoute({ status: 'working', sending: false, provider: 'copilot' })).toBe('queue')
    expect(composedSendRoute({ status: 'working', sending: false, provider: 'codex' })).toBe('queue')
    expect(composedSendRoute({ status: 'working', sending: false, provider: null })).toBe('queue')
  })
})
