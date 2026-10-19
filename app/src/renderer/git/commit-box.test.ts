import { commitBoxState, shouldApplyGeneratedMessage } from './commit-box'

describe('commitBoxState (#335)', () => {
  it('enables commit only with staged files AND a non-empty message', () => {
    const state = commitBoxState(2, 'feat: thing')
    expect(state.canCommit).toBe(true)
    expect(state.disabledReason).toBeNull()
  })

  it('disables with a reason when nothing is staged', () => {
    const state = commitBoxState(0, 'feat: thing')
    expect(state.canCommit).toBe(false)
    expect(state.disabledReason).toMatch(/stage/i)
  })

  it('disables with a reason when the message is blank or whitespace', () => {
    expect(commitBoxState(3, '').canCommit).toBe(false)
    expect(commitBoxState(3, '   \n').canCommit).toBe(false)
    expect(commitBoxState(3, '   ').disabledReason).toMatch(/message/i)
  })

  it('treats a negative/zero staged count as nothing staged', () => {
    expect(commitBoxState(-1, 'msg').canCommit).toBe(false)
    expect(commitBoxState(0, 'msg').canCommit).toBe(false)
  })
})

describe('shouldApplyGeneratedMessage (#1020)', () => {
  it('applies when the draft is untouched since the click (a re-render is not a cancel)', () => {
    expect(shouldApplyGeneratedMessage('', '', 'docs: fix typo')).toBe(true)
    expect(shouldApplyGeneratedMessage('wip', 'wip', 'docs: fix typo')).toBe(true)
  })

  it('drops the result when the user typed into the box since the click', () => {
    expect(
      shouldApplyGeneratedMessage('', 'fix: my own carefully worded message', 'docs: AI text'),
    ).toBe(false)
    // Clearing the box is also an edit — the user chose empty over the old draft.
    expect(shouldApplyGeneratedMessage('old draft', '', 'docs: AI text')).toBe(false)
  })

  it('never applies a null or empty generation result', () => {
    expect(shouldApplyGeneratedMessage('', '', null)).toBe(false)
    expect(shouldApplyGeneratedMessage('', '', '')).toBe(false)
  })
})
