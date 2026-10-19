import { badgeLabel, projectName, splitRoots } from './multi-project-picker'

describe('projectName', () => {
  it('returns the last path segment', () => {
    expect(projectName('/work/engine')).toBe('engine')
    expect(projectName('/work/frontend/')).toBe('frontend')
    expect(projectName('solo')).toBe('solo')
  })
})

describe('badgeLabel', () => {
  it('is empty for no extras', () => {
    expect(badgeLabel([])).toBe('')
  })
  it('lists +name for each extra root', () => {
    expect(badgeLabel(['/work/car', '/work/frontend'])).toBe('+car +frontend')
  })
})

describe('splitRoots', () => {
  it('takes the first selection as primary', () => {
    expect(splitRoots(['/work/engine', '/work/car', '/work/frontend'])).toEqual({
      primary: '/work/engine',
      additional: ['/work/car', '/work/frontend'],
    })
  })

  it('honors a preferred primary when it is selected', () => {
    expect(splitRoots(['/work/engine', '/work/car'], '/work/car')).toEqual({
      primary: '/work/car',
      additional: ['/work/engine'],
    })
  })

  it('dedupes and drops the primary from additional', () => {
    expect(splitRoots(['/work/engine', '/work/engine', '/work/car'])).toEqual({
      primary: '/work/engine',
      additional: ['/work/car'],
    })
  })

  it('is empty-safe', () => {
    expect(splitRoots([])).toEqual({ primary: null, additional: [] })
  })
})
