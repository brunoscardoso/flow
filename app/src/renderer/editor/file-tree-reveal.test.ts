import { normalizeRevealPath, readRevealDetail, revealChain } from './file-tree-reveal'

describe('revealChain', () => {
  it('lists every ancestor root-down, the folder last', () => {
    expect(revealChain('src/components/automations')).toEqual(['src', 'src/components', 'src/components/automations'])
    expect(revealChain('src')).toEqual(['src'])
  })

  it('reads the root as nothing to expand', () => {
    expect(revealChain('.')).toEqual([])
    expect(revealChain('')).toEqual([])
    expect(revealChain('./')).toEqual([])
  })

  it('normalizes slashes and dots, and refuses to leave the root', () => {
    expect(revealChain('./src//a/')).toEqual(['src', 'src/a'])
    expect(revealChain('src\\a')).toEqual(['src', 'src/a'])
    expect(revealChain('src/../etc')).toBeNull()
    expect(normalizeRevealPath('../x')).toBeNull()
  })
})

describe('readRevealDetail', () => {
  it('accepts a root and a relative path, nothing else', () => {
    expect(readRevealDetail({ rootPath: '/p', relPath: '.' })).toEqual({ rootPath: '/p', relPath: '.' })
    expect(readRevealDetail({ rootPath: '', relPath: 'a' })).toBeNull()
    expect(readRevealDetail({ rootPath: '/p' })).toBeNull()
    expect(readRevealDetail(null)).toBeNull()
  })
})
