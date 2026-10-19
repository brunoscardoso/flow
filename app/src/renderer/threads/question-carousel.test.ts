import { carouselView, clampIndex } from './question-carousel'

describe('clampIndex (#400)', () => {
  it('clamps into range', () => {
    expect(clampIndex(-2, 4)).toBe(0)
    expect(clampIndex(9, 4)).toBe(3)
    expect(clampIndex(2, 4)).toBe(2)
  })
  it('is 0 when there are no questions', () => {
    expect(clampIndex(3, 0)).toBe(0)
  })
})

describe('carouselView (#400)', () => {
  it('is not a carousel for a single question (no pager)', () => {
    const v = carouselView(0, 1)
    expect(v.isCarousel).toBe(false)
    expect(v.atStart).toBe(true)
    expect(v.atEnd).toBe(true)
    expect(v.position).toBe('1 of 1')
  })

  it('shows a pager for multiple questions with correct edges', () => {
    expect(carouselView(0, 4)).toMatchObject({ isCarousel: true, atStart: true, atEnd: false, position: '1 of 4' })
    expect(carouselView(1, 4)).toMatchObject({ atStart: false, atEnd: false, position: '2 of 4' })
    expect(carouselView(3, 4)).toMatchObject({ atStart: false, atEnd: true, position: '4 of 4' })
  })

  it('clamps an out-of-range index into the pager', () => {
    expect(carouselView(99, 3)).toMatchObject({ index: 2, atEnd: true, position: '3 of 3' })
    expect(carouselView(-5, 3)).toMatchObject({ index: 0, atStart: true, position: '1 of 3' })
  })
})
