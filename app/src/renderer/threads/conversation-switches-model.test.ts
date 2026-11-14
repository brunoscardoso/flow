import {
  ASK_CHOICES,
  CONVERSATION_SWITCH_STRINGS,
  askingFace,
  autopilotFace,
  needsAskingConfirm,
} from './conversation-switches-model'

describe('askingFace / autopilotFace', () => {
  it('the label names the state, the title what pressing does', () => {
    expect(askingFace(false)).toMatchObject({ label: 'Asks first', on: false })
    expect(askingFace(true)).toMatchObject({ label: "Doesn't ask", on: true })
    expect(autopilotFace(false)).toMatchObject({ label: 'Autopilot off', on: false })
    expect(autopilotFace(true)).toMatchObject({ label: 'Autopilot on', on: true })
    expect(askingFace(false).title).toMatch(/Press to stop asking/)
    expect(askingFace(true).title).toMatch(/asked first again/)
  })
})

describe('needsAskingConfirm', () => {
  it('confirms only turning asking off', () => {
    expect(needsAskingConfirm(false, true)).toBe(true)
    expect(needsAskingConfirm(true, false)).toBe(false)
    expect(needsAskingConfirm(true, true)).toBe(false)
    expect(needsAskingConfirm(false, false)).toBe(false)
  })
})

describe('ASK_CHOICES', () => {
  it('asks first, then does not — one of each', () => {
    expect(ASK_CHOICES.map((choice) => choice.bypass)).toEqual([false, true])
  })
})

describe('forbidden-pattern #12', () => {
  it('no string names a command, a file path or a config key', () => {
    // State the positive first (#28): the scan has something to scan.
    expect(CONVERSATION_SWITCH_STRINGS.length).toBeGreaterThan(15)
    for (const text of CONVERSATION_SWITCH_STRINGS) {
      expect(text).not.toMatch(/planflow-ai|`|\.flowconfig|flow\/|[a-z]+_[a-z]+|autonomy|bypass|\.md\b/i)
    }
  })
})
