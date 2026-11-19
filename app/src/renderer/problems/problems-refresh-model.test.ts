import { DEFAULT_PROBLEMS_LIMIT } from '../../shared/problems-model'
import { DEFAULT_TERMINAL_PROBLEMS_LIMIT } from '../../shared/terminal-problems'
import { problemsReadLimit, terminalProblemsReadLimit } from './problems-refresh-model'

describe('problemsReadLimit — read only what someone can see', () => {
  it('reads the bounded list when the Problems tab is on screen', () => {
    expect(problemsReadLimit({ rendered: true, listShown: true })).toBe(DEFAULT_PROBLEMS_LIMIT)
  })

  it('reads counts only while the terminal is shown — the tab label is all that is visible', () => {
    expect(problemsReadLimit({ rendered: true, listShown: false })).toBe(0)
  })

  it('reads nothing while the bottom panel is hidden, whichever tab is selected', () => {
    expect(problemsReadLimit({ rendered: false, listShown: true })).toBeNull()
    expect(problemsReadLimit({ rendered: false, listShown: false })).toBeNull()
  })
})

describe('terminalProblemsReadLimit — the same cost rules for terminal problems', () => {
  it('reads the bounded list on screen, counts behind the terminal, nothing off screen', () => {
    expect(terminalProblemsReadLimit({ rendered: true, listShown: true })).toBe(DEFAULT_TERMINAL_PROBLEMS_LIMIT)
    expect(terminalProblemsReadLimit({ rendered: true, listShown: false })).toBe(0)
    expect(terminalProblemsReadLimit({ rendered: false, listShown: true })).toBeNull()
  })
})
