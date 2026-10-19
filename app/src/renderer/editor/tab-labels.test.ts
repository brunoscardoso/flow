import { ambiguousAcrossRoots, disambiguateTabLabels } from './tab-labels'

const file = (id: string, relPath: string) => ({ id, relPath })

describe('disambiguateTabLabels (#991)', () => {
  it('leaves a unique basename bare', () => {
    expect(disambiguateTabLabels([file('a', 'src/app.ts')])).toEqual([
      { id: 'a', label: 'app.ts', tooltip: 'src/app.ts' },
    ])
  })

  it('expands ONLY the colliding tabs', () => {
    const out = disambiguateTabLabels([
      file('a', 'src/index.ts'),
      file('b', 'tests/index.ts'),
      file('c', 'src/app.ts'),
    ])
    expect(out.map((t) => t.label)).toEqual(['src/index.ts', 'tests/index.ts', 'app.ts'])
  })

  it('grows the tail until the colliding paths differ', () => {
    const out = disambiguateTabLabels([
      file('a', 'packages/web/src/index.ts'),
      file('b', 'packages/api/src/index.ts'),
    ])
    // one segment up is still 'src/index.ts' for both — go one deeper
    expect(out.map((t) => t.label)).toEqual(['web/src/index.ts', 'api/src/index.ts'])
  })

  it('always carries the full relative path as the tooltip', () => {
    const out = disambiguateTabLabels([file('a', 'src/deep/nested/thing.ts')])
    expect(out[0].tooltip).toBe('src/deep/nested/thing.ts')
  })

  it('is order-independent and deterministic', () => {
    const a = disambiguateTabLabels([file('a', 'src/index.ts'), file('b', 'tests/index.ts')])
    const b = disambiguateTabLabels([file('b', 'tests/index.ts'), file('a', 'src/index.ts')])
    expect(new Map(a.map((t) => [t.id, t.label]))).toEqual(new Map(b.map((t) => [t.id, t.label])))
  })

  it('handles a bare root-level file and identical paths without throwing', () => {
    const out = disambiguateTabLabels([file('a', 'README.md'), file('b', 'README.md')])
    expect(out).toHaveLength(2)
    expect(out.every((t) => t.tooltip === 'README.md')).toBe(true)
  })
})

// #1482 — in a multi-project thread two repos routinely hold the SAME relative
// path, and no amount of path tail can separate them: the tails are identical
// all the way up. The root is the only distinguishing segment there is.
describe('two roots holding the same relative path (#1482)', () => {
  const FILES = [
    { id: '/w/alpha/src/index.ts', relPath: 'src/index.ts', rootPath: '/w/alpha' },
    { id: '/w/beta/src/index.ts', relPath: 'src/index.ts', rootPath: '/w/beta' },
  ]

  it('qualifies each label by its root instead of rendering two identical tabs', () => {
    const labels = disambiguateTabLabels(FILES)
    expect(labels.map((l) => l.label)).toEqual(['alpha ▸ src/index.ts', 'beta ▸ src/index.ts'])
    expect(new Set(labels.map((l) => l.label)).size).toBe(2)
  })

  it('makes the tooltip absolute — a bare relPath would name the wrong file', () => {
    const labels = disambiguateTabLabels(FILES)
    expect(labels.map((l) => l.tooltip)).toEqual(['/w/alpha/src/index.ts', '/w/beta/src/index.ts'])
  })

  it('leaves same-root collisions to the existing path-tail rule', () => {
    const labels = disambiguateTabLabels([
      { id: '/w/a/src/index.ts', relPath: 'src/index.ts', rootPath: '/w/a' },
      { id: '/w/a/tests/index.ts', relPath: 'tests/index.ts', rootPath: '/w/a' },
    ])
    expect(labels.map((l) => l.label)).toEqual(['src/index.ts', 'tests/index.ts'])
  })

  it('changes nothing when callers pass no root at all', () => {
    const labels = disambiguateTabLabels([
      { id: 'a', relPath: 'src/index.ts' },
      { id: 'b', relPath: 'tests/index.ts' },
    ])
    expect(labels.map((l) => l.label)).toEqual(['src/index.ts', 'tests/index.ts'])
  })
})

describe('ambiguousAcrossRoots (#1482)', () => {
  it('flags only the ids whose relPath exists under more than one root', () => {
    const ambiguous = ambiguousAcrossRoots([
      { id: 'a1', relPath: 'src/index.ts', rootPath: '/w/alpha' },
      { id: 'b1', relPath: 'src/index.ts', rootPath: '/w/beta' },
      { id: 'a2', relPath: 'src/only-here.ts', rootPath: '/w/alpha' },
    ])
    expect([...ambiguous].sort()).toEqual(['a1', 'b1'])
  })

  it('is empty for a single root, so single-project tabs are untouched', () => {
    expect(
      ambiguousAcrossRoots([
        { id: 'a', relPath: 'src/index.ts', rootPath: '/w/alpha' },
        { id: 'b', relPath: 'tests/index.ts', rootPath: '/w/alpha' },
      ]).size,
    ).toBe(0)
  })
})
