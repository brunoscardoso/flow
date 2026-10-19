import { answeredCount, firstUnansweredIndex } from './question-completeness'

describe('firstUnansweredIndex (#414)', () => {
  it('finds the first gap', () => {
    expect(firstUnansweredIndex([true, false, false])).toBe(1)
    expect(firstUnansweredIndex([false, true])).toBe(0)
  })
  it('is -1 when everything is answered', () => {
    expect(firstUnansweredIndex([true, true, true])).toBe(-1)
    expect(firstUnansweredIndex([])).toBe(-1)
  })
})

describe('answeredCount (#414)', () => {
  it('counts answered questions', () => {
    expect(answeredCount([true, false, true, false])).toBe(2)
    expect(answeredCount([true, true])).toBe(2)
    expect(answeredCount([false, false])).toBe(0)
    expect(answeredCount([])).toBe(0)
  })
})
