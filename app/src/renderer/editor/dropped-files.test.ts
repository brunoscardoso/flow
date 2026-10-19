import {
  MAX_DROPPED_FILES,
  planDrop,
  resolveDroppedFile,
  resolveDroppedFiles,
} from './dropped-files'

// #1339: dragging a file in from Finder did nothing useful anywhere — and over
// an open buffer Monaco's own drop provider pasted the path plus a literal
// `$0` INTO the source file.

describe('resolveDroppedFile (#1339)', () => {
  it('addresses the file the way the editor opens files', () => {
    expect(resolveDroppedFile('/work/repo/src/a.ts', ['/work/repo'])).toEqual({
      rootPath: '/work/repo',
      relPath: 'src/a.ts',
    })
  })

  it('lets a NESTED root claim its own files', () => {
    // Longest match wins, or the parent would open a file the child owns.
    expect(resolveDroppedFile('/work/repo/pkg/src/a.ts', ['/work/repo', '/work/repo/pkg'])).toEqual({
      rootPath: '/work/repo/pkg',
      relPath: 'src/a.ts',
    })
  })

  it('is null for a file outside every open root', () => {
    // Opening it would give the editor a buffer with no project, no LSP and no
    // save target; adopting its parent as a project root is a far bigger
    // decision than a drag should make. The caller says so instead.
    expect(resolveDroppedFile('/elsewhere/a.ts', ['/work/repo'])).toBeNull()
  })

  it('is null with no roots open at all', () => {
    expect(resolveDroppedFile('/work/repo/a.ts', [])).toBeNull()
  })

  it('does not treat the root itself as a droppable file', () => {
    expect(resolveDroppedFile('/work/repo', ['/work/repo'])).toBeNull()
  })

  it('does not match a sibling whose name merely starts the same', () => {
    expect(resolveDroppedFile('/work/repo-two/a.ts', ['/work/repo'])).toBeNull()
  })

  it('normalises Windows separators', () => {
    expect(resolveDroppedFile('C:\\work\\repo\\src\\a.ts', ['C:/work/repo'])).toEqual({
      rootPath: 'C:/work/repo',
      relPath: 'src/a.ts',
    })
  })

  it('tolerates a trailing slash on the root', () => {
    expect(resolveDroppedFile('/work/repo/a.ts', ['/work/repo/'])?.relPath).toBe('a.ts')
  })
})

describe('resolveDroppedFiles (#1339)', () => {
  it('keeps what lands inside a root and skips the rest', () => {
    const out = resolveDroppedFiles(['/work/repo/a.ts', '/elsewhere/b.ts'], ['/work/repo'])
    expect(out.map((file) => file.relPath)).toEqual(['a.ts'])
  })
})

describe('planDrop (#1339)', () => {
  it('opens what it can and says nothing when everything opened', () => {
    const plan = planDrop(['/work/repo/a.ts'], ['/work/repo'])
    expect(plan.open).toHaveLength(1)
    expect(plan.notice).toBeNull()
  })

  it('reports files outside the project rather than swallowing them', () => {
    // Silently doing nothing is the bug being fixed; a drop that opens
    // nothing must say why.
    const plan = planDrop(['/elsewhere/a.ts'], ['/work/repo'])
    expect(plan.open).toEqual([])
    expect(plan.notice).toContain('1 file outside the open project')
  })

  it('caps a folder-full and reports the remainder', () => {
    const many = Array.from({ length: 15 }, (_unused, i) => `/work/repo/f${i}.ts`)
    const plan = planDrop(many, ['/work/repo'])
    expect(plan.open).toHaveLength(MAX_DROPPED_FILES)
    expect(plan.notice).toContain('5 more not opened')
  })

  it('is inert for an empty drop', () => {
    expect(planDrop([], ['/work/repo'])).toEqual({ open: [], notice: null })
  })
})
