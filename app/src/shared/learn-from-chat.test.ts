import { LEARN_FROM_CHAT_COPY, learnFromChatEnabled } from './learn-from-chat'

describe('learning from chat', () => {
  it('runs only after an explicit yes — not asked is off', () => {
    expect(learnFromChatEnabled(true)).toBe(true)
    expect(learnFromChatEnabled(false)).toBe(false)
    expect(learnFromChatEnabled(null)).toBe(false)
  })

  it('says it costs tokens and names no internals', () => {
    expect(LEARN_FROM_CHAT_COPY.question).toMatch(/tokens/)
    const all = JSON.stringify(LEARN_FROM_CHAT_COPY)
    expect(all).not.toMatch(/planflow-ai|flowconfig|learn_|\.md\b|`/)
  })
})
