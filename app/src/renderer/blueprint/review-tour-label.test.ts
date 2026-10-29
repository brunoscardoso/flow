// The tour's step label — pure, no DOM (node test env).

import type { TourStep } from './review-tour-model'
import { tourStepLabel } from './review-tour-model'

function step(over: Partial<TourStep> = {}): TourStep {
  return {
    n: 2,
    boxId: 'piece-2',
    line: 12,
    phase: 2,
    phaseTitle: 'Data',
    kind: 'change',
    subject: 'the function save',
    title: 'save',
    codeFound: true,
    codeMessage: null,
    story: { file: 'store.ts', action: 'Changing save', change: null, reason: null, result: null },
    ...over,
  }
}

describe('tourStepLabel', () => {
  it('names the step, the count and the phase with its title', () => {
    expect(tourStepLabel(step(), 1, 6)).toBe('Step 2 of 6 · Phase 2 · Data')
  })

  it('names the phase by number alone when the plan gave it no title', () => {
    expect(tourStepLabel(step({ phaseTitle: null }), 0, 3)).toBe('Step 1 of 3 · Phase 2')
  })
})
