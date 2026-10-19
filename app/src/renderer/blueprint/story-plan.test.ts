import type { StorylineAnswer, StorylineCompare } from '../../shared/ipc-contract'
import { compareTouchesStory, storyPlanFor, storyPlanOf, withTouchingCompare } from './story-plan'

function compare(summary: Partial<StorylineCompare['summary']> = {}): StorylineCompare {
  return {
    plan: 'learn-review',
    base: null,
    baseSource: null,
    pieces: {},
    removed: [],
    hunks: {},
    hiddenLines: {},
    unreadable: [],
    predicted: [],
    summary: { changed: 0, added: 0, removed: 0, predicted: 0, planned: 0, ...summary },
  }
}

function answer(withCompare: StorylineCompare | undefined): StorylineAnswer {
  return {
    ok: true,
    scope: 'file',
    files: ['src/a.ts'],
    pieces: [],
    ...(withCompare === undefined ? {} : { compare: withCompare }),
  } as unknown as StorylineAnswer
}

describe('storyPlanOf', () => {
  it('names the compiled story\'s plan', () => {
    expect(storyPlanOf({ plan: 'learn-review' })).toBe('learn-review')
  })

  it('names nothing without a story, or with a blank plan', () => {
    expect(storyPlanOf(null)).toBeNull()
    expect(storyPlanOf(undefined)).toBeNull()
    expect(storyPlanOf({ plan: '  ' })).toBeNull()
  })
})

describe('compareTouchesStory', () => {
  it('is true when the plan changed, added, removed, predicts or plans anything here', () => {
    expect(compareTouchesStory(compare({ changed: 1 }))).toBe(true)
    expect(compareTouchesStory(compare({ predicted: 2 }))).toBe(true)
    expect(compareTouchesStory(compare({ planned: 1 }))).toBe(true)
  })

  it('is false when the plan says nothing about this story', () => {
    expect(compareTouchesStory(compare())).toBe(false)
  })
})

describe('withTouchingCompare', () => {
  it('keeps a comparison that touches the story', () => {
    const touched = answer(compare({ added: 1 }))
    expect(withTouchingCompare(touched)).toBe(touched)
  })

  it('drops a comparison that touches nothing, keeping the rest of the answer', () => {
    const result = withTouchingCompare(answer(compare()))
    expect(result.ok).toBe(true)
    expect(result.ok && result.compare).toBeUndefined()
    expect(result.ok && result.files).toEqual(['src/a.ts'])
  })

  it('leaves a refusal and an answer without a comparison alone', () => {
    const refusal: StorylineAnswer = { ok: false, reason: 'not-found', sentence: 'gone' }
    expect(withTouchingCompare(refusal)).toBe(refusal)
    const plain = answer(undefined)
    expect(withTouchingCompare(plain)).toBe(plain)
  })
})


describe('storyPlanFor (plan change review)', () => {
  it('the plan under review wins; without one, the compiled story names it as before', () => {
    expect(storyPlanFor({ plan: 'pay' }, { plan: 'learn-review' })).toBe('pay')
    expect(storyPlanFor(null, { plan: 'learn-review' })).toBe('learn-review')
    expect(storyPlanFor({ plan: ' ' }, null)).toBeNull()
  })

  it('keeps a plan with change notes even when nothing is counted', () => {
    const withNotes = compare()
    withNotes.predicted = [{ kind: 'note-file', file: 'src/a.ts', note: { n: 1, phase: 1, kind: 'file', target: 'x', file: 'src/a.ts', status: 'proposed', comments: [] } }]
    expect(withTouchingCompare(answer(withNotes))).toEqual(answer(withNotes))
  })
})
