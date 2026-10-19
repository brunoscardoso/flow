import { isAppDrivenTaskPatch } from './task-activity'

// #1192: only the agent's turn-complete signal may skip the board's sort clock.
// Everything a USER does must still surface its task.

describe('isAppDrivenTaskPatch (#1192)', () => {
  it('treats a lone suggestDone:true as the agent’s signal', () => {
    expect(isAppDrivenTaskPatch({ suggestDone: true })).toBe(true)
  })

  it('treats the Done? chip as a user action — it clears the flag too', () => {
    expect(isAppDrivenTaskPatch({ lane: 'done', suggestDone: false })).toBe(false)
  })

  it('treats a drag as a user action', () => {
    expect(isAppDrivenTaskPatch({ lane: 'doing', suggestDone: false })).toBe(false)
    expect(isAppDrivenTaskPatch({ lane: 'doing' })).toBe(false)
  })

  it('treats a rename and an archive as user actions', () => {
    expect(isAppDrivenTaskPatch({ title: 'renamed' })).toBe(false)
    expect(isAppDrivenTaskPatch({ archived: true })).toBe(false)
  })

  it('does not mistake suggestDone:false for the signal', () => {
    expect(isAppDrivenTaskPatch({ suggestDone: false })).toBe(false)
  })

  it('ignores explicitly-undefined fields when counting the shape', () => {
    expect(isAppDrivenTaskPatch({ suggestDone: true, title: undefined })).toBe(true)
  })
})
