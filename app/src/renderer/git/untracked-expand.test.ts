import type { GitFileChange } from '../../shared/ipc-contract'
import {
  interleaveUntrackedChildren,
  isUntrackedDir,
  sameStringList,
  type UntrackedDisplayRow,
} from './untracked-expand'

describe('sameStringList (#647)', () => {
  it('is true for identical lists, false on any difference', () => {
    expect(sameStringList(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameStringList([], [])).toBe(true)
    expect(sameStringList(['a'], ['a', 'b'])).toBe(false) // added file
    expect(sameStringList(['a', 'b'], ['a'])).toBe(false) // removed file
    expect(sameStringList(['a', 'b'], ['a', 'c'])).toBe(false) // changed
  })
})

function change(filePath: string, state: GitFileChange['state'] = 'untracked'): GitFileChange {
  return { filePath, state, staged: false }
}

describe('isUntrackedDir', () => {
  it('is true only for an untracked trailing-slash path', () => {
    expect(isUntrackedDir(change('app/(protected)/'))).toBe(true)
    expect(isUntrackedDir(change('app/(protected)/page.tsx'))).toBe(false) // a file
    expect(isUntrackedDir(change('app/x/', 'modified'))).toBe(false) // not untracked
  })
})

describe('interleaveUntrackedChildren (#615)', () => {
  const rows = (r: UntrackedDisplayRow[]) => r.map((row) => `${row.kind}:${row.change.filePath}`)

  it('passes normal + dir rows through unchanged when nothing is expanded', () => {
    const changes = [change('src/a.ts', 'modified'), change('app/(protected)/')]
    const out = interleaveUntrackedChildren(changes, new Set(), new Map())
    expect(rows(out)).toEqual(['normal:src/a.ts', 'dir:app/(protected)/'])
  })

  it('reveals an expanded dir’s children as indented child rows right after it', () => {
    const changes = [change('app/(protected)/'), change('src/z.ts', 'modified')]
    const expanded = new Set(['app/(protected)/'])
    const kids = new Map([['app/(protected)/', ['app/(protected)/layout.tsx', 'app/(protected)/page.tsx']]])
    const out = interleaveUntrackedChildren(changes, expanded, kids)
    expect(rows(out)).toEqual([
      'dir:app/(protected)/',
      'child:app/(protected)/layout.tsx',
      'child:app/(protected)/page.tsx',
      'normal:src/z.ts',
    ])
    // Child rows are untracked file changes tagged with their parent dir.
    const child = out.find((r) => r.kind === 'child')
    expect(child?.change.state).toBe('untracked')
    expect(child?.parentDir).toBe('app/(protected)/')
  })

  it('renders an expanded dir alone until its children are fetched (cache miss)', () => {
    const out = interleaveUntrackedChildren(
      [change('app/(protected)/')],
      new Set(['app/(protected)/']),
      new Map(),
    )
    expect(rows(out)).toEqual(['dir:app/(protected)/'])
  })

  it('does not reveal children for a collapsed (cached but not expanded) dir', () => {
    const kids = new Map([['app/(protected)/', ['app/(protected)/page.tsx']]])
    const out = interleaveUntrackedChildren([change('app/(protected)/')], new Set(), kids)
    expect(rows(out)).toEqual(['dir:app/(protected)/'])
  })
})
