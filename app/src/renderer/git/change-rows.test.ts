import { buildTreeRows, fileIconFor, parseViewMode, splitPath, type TreeRow } from './change-rows'

describe('splitPath', () => {
  it('puts the name first and the folder after', () => {
    expect(splitPath('app/src/renderer/a.ts')).toEqual({ name: 'a.ts', dir: 'app/src/renderer' })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
  })

  it('names a rolled-up untracked folder after itself', () => {
    expect(splitPath('app/new/')).toEqual({ name: 'new', dir: 'app' })
  })
})

describe('fileIconFor', () => {
  it('marks the type in text, never an emoji', () => {
    expect(fileIconFor('a/b.ts')).toEqual({ label: 'TS', tone: 'ts' })
    expect(fileIconFor('a/b.spec.ts')).toEqual({ label: 'TS', tone: 'test' })
    expect(fileIconFor('a/b.test.js')).toEqual({ label: 'JS', tone: 'test' })
    expect(fileIconFor('package.json')).toEqual({ label: '{}', tone: 'json' })
    expect(fileIconFor('notes.md').tone).toBe('md')
    expect(fileIconFor('Makefile')).toEqual({ label: '', tone: 'plain' })
    expect(fileIconFor('new/')).toEqual({ label: '', tone: 'folder' })
  })
})

describe('buildTreeRows', () => {
  const files = ['app/src/b.ts', 'app/src/a.ts', 'app/e2e/x.spec.ts', 'README.md']
  const describeRows = (rows: Array<TreeRow<string>>): string[] =>
    rows.map((row) => (row.kind === 'folder' ? `${'  '.repeat(row.depth)}[${row.label}]` : `${'  '.repeat(row.depth)}${row.item}`))

  it('nests under folders, folders first, compacting single-child chains', () => {
    expect(describeRows(buildTreeRows(files, (f) => f, new Set()))).toEqual([
      '[app]',
      '  [e2e]',
      '    app/e2e/x.spec.ts',
      '  [src]',
      '    app/src/a.ts',
      '    app/src/b.ts',
      'README.md',
    ])
    expect(describeRows(buildTreeRows(['a/b/c/d.ts'], (f) => f, new Set()))).toEqual(['[a/b/c]', '  a/b/c/d.ts'])
  })

  it('hides what a collapsed folder holds and keeps its count', () => {
    const rows = buildTreeRows(files, (f) => f, new Set(['app/src']))
    expect(describeRows(rows)).toEqual(['[app]', '  [e2e]', '    app/e2e/x.spec.ts', '  [src]', 'README.md'])
    const src = rows.find((row) => row.kind === 'folder' && row.path === 'app/src')
    expect(src).toMatchObject({ collapsed: true, count: 2 })
  })

  it('puts an expanded untracked folder’s files right under it, one level deeper', () => {
    const rows = buildTreeRows(['app/new/', 'app/a.ts'], (f) => f, new Set(), (item) =>
      item === 'app/new/' ? ['app/new/one.ts', 'app/new/two.ts'] : [],
    )
    expect(describeRows(rows)).toEqual(['[app]', '  app/a.ts', '  app/new/', '    app/new/one.ts', '    app/new/two.ts'])
  })
})

describe('parseViewMode', () => {
  it('defaults to list for anything unexpected', () => {
    expect(parseViewMode('tree')).toBe('tree')
    expect(parseViewMode(null)).toBe('list')
    expect(parseViewMode('grid')).toBe('list')
  })
})
