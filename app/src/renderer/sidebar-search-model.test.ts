import {
  fileHits,
  flatHits,
  groupResults,
  moveCursor,
  newActionFor,
  newMenuFor,
  searchModeFor,
  normaliseQuery,
  tabAccessibleName,
  threadHits,
} from './sidebar-search-model'

describe('sidebar search model', () => {
  it('ranks a file whose name starts with the query above one that only contains it, and path matches last', () => {
    const hits = fileHits(
      [
        {
          rootPath: '/repo',
          relPaths: [
            'src/coworker/index.ts',
            'src/hooks/useCoworkers.ts',
            'src/CoworkerPanel/CoworkerPanel.tsx',
            'src/other.ts',
          ],
        },
      ],
      'Coworker',
    )
    expect(hits.map((hit) => hit.relPath)).toEqual([
      'src/CoworkerPanel/CoworkerPanel.tsx',
      'src/hooks/useCoworkers.ts',
      'src/coworker/index.ts',
    ])
    expect(hits[0]).toMatchObject({ name: 'CoworkerPanel.tsx', folder: 'src/CoworkerPanel', rootPath: '/repo' })
  })

  it('finds nothing for an empty query and caps the file list', () => {
    expect(fileHits([{ rootPath: '/r', relPaths: ['a.ts'] }], '   ')).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => `f${String(i)}.ts`)
    expect(fileHits([{ rootPath: '/r', relPaths: many }], 'f', 8)).toHaveLength(8)
  })

  it('keeps only threads of the projects in view, in the store order', () => {
    const hits = threadHits(
      [
        { id: 'a', title: 'A', projectRoot: '/in' },
        { id: 'b', title: 'B', projectRoot: '/out' },
        { id: 'c', title: 'C', projectRoot: '/in' },
      ],
      ['/in'],
    )
    expect(hits.map((hit) => hit.id)).toEqual(['a', 'c'])
  })

  it('puts the open tab’s kind first and drops empty groups', () => {
    const threads = threadHits([{ id: 't', title: 'T', projectRoot: '/r' }], [])
    const files = fileHits([{ rootPath: '/r', relPaths: ['t.ts'] }], 't')
    expect(groupResults(threads, files, 'threads').map((g) => g.kind)).toEqual(['threads', 'files'])
    expect(groupResults(threads, files, 'files').map((g) => g.kind)).toEqual(['files', 'threads'])
    expect(groupResults([], files, 'threads').map((g) => g.kind)).toEqual(['files'])
    expect(groupResults(threads, files, 'threads', 'files').map((g) => g.kind)).toEqual(['files'])
    expect(flatHits(groupResults(threads, files, 'files')).map((hit) => hit.kind)).toEqual(['file', 'thread'])
  })

  it('wraps the keyboard cursor at both ends', () => {
    expect(moveCursor(-1, 1, 3)).toBe(0)
    expect(moveCursor(-1, -1, 3)).toBe(2)
    expect(moveCursor(2, 1, 3)).toBe(0)
    expect(moveCursor(0, -1, 3)).toBe(2)
    expect(moveCursor(0, 1, 0)).toBe(-1)
  })

  it('makes a thread from Threads and Changes, and a file from Files', () => {
    expect(newActionFor('threads')).toEqual({ label: 'New thread', event: 'flow:new-thread' })
    expect(newActionFor('source-control')).toEqual({ label: 'New thread', event: 'flow:new-thread' })
    expect(newActionFor('files')).toEqual({ label: 'New file', event: 'flow:new-file' })
  })

  it('lists the open tab’s own thing first on the New menu', () => {
    expect(newMenuFor('threads').map((entry) => entry.label)).toEqual([
      'New thread',
      'New file',
      'New terminal',
      'Ask the Blueprint',
    ])
    expect(newMenuFor('files')[0]).toEqual({ label: 'New file', icon: 'file', event: 'flow:new-file' })
  })

  it('filters the thread list in place on Threads, groups results elsewhere', () => {
    expect(searchModeFor('threads')).toBe('filter-list')
    expect(searchModeFor('files')).toBe('grouped')
    expect(searchModeFor('source-control')).toBe('grouped')
  })

  it('normalises the query and names a counted tab for screen readers', () => {
    expect(normaliseQuery('  CoWorker ')).toBe('coworker')
    expect(tabAccessibleName('Changes', 3)).toBe('Changes, 3 changed files')
    expect(tabAccessibleName('Changes', 1)).toBe('Changes, 1 changed file')
    expect(tabAccessibleName('Changes', 0)).toBe('Changes')
    expect(tabAccessibleName('Threads', null)).toBe('Threads')
  })
})
