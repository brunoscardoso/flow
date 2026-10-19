import { storyMatchesDoc } from './preview-menu-model'

describe('storyMatchesDoc (#preview-mismatch)', () => {
  it('matches only the exact narrated source doc', () => {
    const story = { sourcePath: 'flow/plans/plan_unified_observability_v1.md' }
    expect(storyMatchesDoc(story, 'flow/plans/plan_unified_observability_v1.md')).toBe(true)
    expect(storyMatchesDoc(story, './flow/plans/plan_unified_observability_v1.md')).toBe(true)
    expect(storyMatchesDoc(story, 'flow/plans/plan_knowledge_hub_availability_v1.md')).toBe(false)
  })

  it('a missing story or sourcePath never matches', () => {
    expect(storyMatchesDoc(null, 'flow/plans/plan_x_v1.md')).toBe(false)
    expect(storyMatchesDoc({}, 'flow/plans/plan_x_v1.md')).toBe(false)
  })
})
