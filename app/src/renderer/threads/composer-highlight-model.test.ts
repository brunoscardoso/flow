import { highlightBoxWork } from './composer-highlight-model'

describe('the highlight mirror copies the box only when the box can have changed', () => {
  it('a keystroke while highlighting copies nothing and measures nothing', () => {
    expect(highlightBoxWork('input', true, false)).toEqual({ copyStyle: false, place: false })
  })

  it('highlighting turning on copies and places, whatever started it', () => {
    expect(highlightBoxWork('input', true, true)).toEqual({ copyStyle: true, place: true })
  })

  it('a resize places; a font or theme change copies and places', () => {
    expect(highlightBoxWork('resize', true, false)).toEqual({ copyStyle: false, place: true })
    expect(highlightBoxWork('style', true, false)).toEqual({ copyStyle: true, place: true })
  })

  it('nothing at all while the field draws itself', () => {
    for (const trigger of ['input', 'resize', 'style'] as const) {
      expect(highlightBoxWork(trigger, false, false)).toEqual({ copyStyle: false, place: false })
    }
  })
})
