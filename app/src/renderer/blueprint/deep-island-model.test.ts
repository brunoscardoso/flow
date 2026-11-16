import { askAboutPlaceholder, deepKnowledgeView, filesAmong, toggleSheet } from './deep-island-model'

describe('toggleSheet', () => {
  it('opens the pressed tab, swaps to another, and folds the open one', () => {
    expect(toggleSheet(null, 'Known problems')).toBe('Known problems')
    expect(toggleSheet('Known problems', 'Verification')).toBe('Verification')
    expect(toggleSheet('Verification', 'Verification')).toBeNull()
  })
})

describe('askAboutPlaceholder', () => {
  it('names the thing the question is about', () => {
    expect(askAboutPlaceholder('Auth')).toBe('Ask about Auth…')
  })
})

describe('deepKnowledgeView', () => {
  it('says the share understood and the feature figures on one line', () => {
    const view = deepKnowledgeView({ understood: { done: 8, total: 9 }, files: 62, parts: 9 })
    expect(view.line1).toBe('89% understood')
    expect(view.line2).toBe('62 files · 9 parts')
    expect(view.ring).toBeCloseTo(8 / 9)
    expect(view.title).toContain('8 of 9 understood')
  })
  it('drops figures it does not have, and says nothing is learned rather than 0% of nothing', () => {
    const view = deepKnowledgeView({ understood: null, files: null, parts: 1 })
    expect(view.line1).toBe('Nothing learned yet')
    expect(view.line2).toBe('1 part')
    expect(view.ring).toBe(0)
    expect(deepKnowledgeView({ understood: null, files: 0, parts: 0 }).line2).toBeNull()
  })
})

describe('filesAmong', () => {
  it('counts file anchors only', () => {
    expect(filesAmong([{ ref: 'file:a.ts' }, { ref: 'module:src' }, { ref: 'file:b.ts' }])).toBe(2)
    expect(filesAmong([{ ref: 'module:src' }])).toBeNull()
  })
})
