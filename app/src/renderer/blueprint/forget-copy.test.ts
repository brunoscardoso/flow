import type { LearnForgetTally } from '../../shared/ipc-contract'
import { FORGET_KEEPS, forgetIsEmpty, forgetQuestion, forgetResult } from './forget-copy'

/**
 * Reported live, at a board that had just been reset: "i reset the learn, why
 * we still having data on the blueprint?" The button had asked "Reset learning
 * for 5 modules?" — five being the number of rows in a status table — and then
 * cleared exactly that, leaving 400 module docs, 506 notes, 2,131 heat ticks
 * and every feature's learned sections in place.
 *
 * The question now names the work. These hold the wording, because the wording
 * is the part that was wrong.
 */
const tally = (over: Partial<LearnForgetTally> = {}): LearnForgetTally => ({
  moduleDocs: 0,
  notes: 0,
  heat: 0,
  learningRows: 0,
  featureViews: 0,
  featuresStripped: 0,
  featuresSkipped: [],
  ...over,
})

describe('what Reset says it will forget', () => {
  it('names the work, not the bookkeeping', () => {
    const question = forgetQuestion(
      tally({ moduleDocs: 400, notes: 506, heat: 2131, featuresStripped: 41, learningRows: 5 }),
    )
    expect(question).toContain('400 module docs')
    expect(question).toContain('506 notes')
    expect(question).toContain('what was learned about 41 features')
    // The status rows are still counted — last, where they belong.
    expect(question.indexOf('5 status rows')).toBeGreaterThan(question.indexOf('400 module docs'))
  })

  it('drops the zeroes — a sentence about deleting things has no room for them', () => {
    expect(forgetQuestion(tally({ moduleDocs: 3 }))).toBe('Forget 3 module docs?')
  })

  it('counts one of a thing as one of a thing', () => {
    expect(forgetQuestion(tally({ notes: 1, heat: 1 }))).toBe('Forget 1 note and 1 heat tick?')
  })

  it('says so plainly when there is nothing to forget', () => {
    expect(forgetIsEmpty(tally())).toBe(true)
    expect(forgetQuestion(tally())).toBe('Nothing has been learned here yet.')
    expect(forgetResult(tally())).toBe('There was nothing to forget.')
  })

  it('reports afterwards in the same terms it asked in', () => {
    const done = forgetResult(tally({ moduleDocs: 400, notes: 506 }))
    expect(done).toBe('Forgot 400 module docs and 506 notes.')
  })

  it('mentions a feature file it left alone, and why', () => {
    const done = forgetResult(tally({ notes: 2, featuresSkipped: ['auth.md'] }))
    expect(done).toContain('1 feature file kept its learned section')
    expect(done).toContain('by hand')
  })

  it('says what survives — the reason a person can press it', () => {
    expect(FORGET_KEEPS).toContain('names and descriptions')
    expect(FORGET_KEEPS).toContain('untouched')
  })
})
