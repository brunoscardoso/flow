import { adjudicableClaimPaths, isClaimImagePath } from './claim-files'

// #1130: the learn/verify sessions are caged TEXT readers, so an image claim
// could only ever return `unverifiable` — burning prompt budget and leaving
// permanently-unverified rows whose Verify button did nothing.

describe('isClaimImagePath (#1130)', () => {
  it.each(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.avif', '.ico'])(
    'treats %s as an image',
    (ext) => {
      expect(isClaimImagePath(`assets/diagram${ext}`)).toBe(true)
    },
  )

  it('is case-insensitive and separator-insensitive', () => {
    expect(isClaimImagePath('Assets/Diagram.PNG')).toBe(true)
    expect(isClaimImagePath('assets\\diagram.svg')).toBe(true)
  })

  it('leaves real docs alone — they are the whole point of the tier', () => {
    for (const doc of ['README.md', 'docs/guide.mdx', 'notes.rst', 'notes.txt']) {
      expect(isClaimImagePath(doc)).toBe(false)
    }
  })

  it('does not match an extension appearing mid-path', () => {
    expect(isClaimImagePath('src/svg/render.ts')).toBe(false)
    expect(isClaimImagePath('png.md')).toBe(false)
  })
})

describe('adjudicableClaimPaths (#1130)', () => {
  it('drops images and keeps docs, preserving order', () => {
    const files = [
      { path: 'README.md' },
      { path: 'assets/diagram.png' },
      { path: 'docs/api.md' },
      { path: 'logo.svg' },
    ]
    expect(adjudicableClaimPaths(files).map((f) => f.path)).toEqual(['README.md', 'docs/api.md'])
  })

  it('returns nothing when every claim is an image', () => {
    expect(adjudicableClaimPaths([{ path: 'a.png' }, { path: 'b.svg' }])).toEqual([])
  })
})
