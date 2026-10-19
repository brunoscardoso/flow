import { enterKeyIntent } from './composer-keys'

describe('enterKeyIntent (#139)', () => {
  const base = { shiftKey: false, altKey: false, isComposing: false }

  it('plain Enter sends', () => {
    expect(enterKeyIntent(base)).toBe('send')
  })

  it('Shift+Enter and Alt+Enter insert a newline', () => {
    expect(enterKeyIntent({ ...base, shiftKey: true })).toBe('newline')
    expect(enterKeyIntent({ ...base, altKey: true })).toBe('newline')
  })

  it('does nothing while an IME is composing (Enter confirms the character)', () => {
    expect(enterKeyIntent({ ...base, isComposing: true })).toBe('none')
    // composing wins even with a modifier held
    expect(enterKeyIntent({ shiftKey: true, altKey: false, isComposing: true })).toBe('none')
  })
})
