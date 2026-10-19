// Files-list model — pure logic, no DOM (node env). Covers source-first
// ordering, the cap + overflow count, an empty dir, and the listDir-failure
// passthrough (null in → null out, the board's fail-soft cue).

import type { DirectoryEntry, GitFileChange } from '../../shared/ipc-contract'
import { MAX_POPOVER_FILES, buildFileList, isSourceFileName } from './files-model'

function entry(name: string, type: DirectoryEntry['type'] = 'file'): DirectoryEntry {
  return { name, path: `/abs/${name}`, type }
}

describe('isSourceFileName', () => {
  it('recognizes common source extensions', () => {
    expect(isSourceFileName('index.ts')).toBe(true)
    expect(isSourceFileName('App.tsx')).toBe(true)
    expect(isSourceFileName('main.py')).toBe(true)
  })

  it('rejects non-source extensions and dotfiles with no extension', () => {
    expect(isSourceFileName('README.md')).toBe(false)
    expect(isSourceFileName('.gitignore')).toBe(false)
    expect(isSourceFileName('Makefile')).toBe(false)
  })
})

describe('buildFileList', () => {
  it('returns null straight through on a listDir failure (entries === null)', () => {
    expect(buildFileList('app/src/main', null)).toBeNull()
  })

  it('returns an empty result for an empty directory', () => {
    expect(buildFileList('app/src/main', [])).toEqual({ files: [], overflow: 0 })
  })

  it('excludes directories, keeping only files', () => {
    const result = buildFileList('app/src/main', [entry('index.ts'), entry('sub', 'directory')])
    expect(result?.files).toEqual([{ name: 'index.ts', relPath: 'app/src/main/index.ts' }])
  })

  it('sorts source files before others, alpha within each group', () => {
    const result = buildFileList('app/src/main', [
      entry('README.md'),
      entry('zeta.ts'),
      entry('alpha.ts'),
      entry('config.json'),
    ])
    expect(result?.files.map((f) => f.name)).toEqual(['alpha.ts', 'zeta.ts', 'config.json', 'README.md'])
  })

  it('joins the relative path against the module dir, handling a root ("") dir', () => {
    const result = buildFileList('', [entry('index.ts')])
    expect(result?.files).toEqual([{ name: 'index.ts', relPath: 'index.ts' }])
  })

  it('caps at MAX_POPOVER_FILES and reports the overflow count', () => {
    const entries = Array.from({ length: MAX_POPOVER_FILES + 3 }, (_, i) => entry(`file-${i}.ts`))
    const result = buildFileList('app/src/main', entries)
    expect(result?.files).toHaveLength(MAX_POPOVER_FILES)
    expect(result?.overflow).toBe(3)
  })

  it('reports zero overflow when at or under the cap', () => {
    const entries = Array.from({ length: MAX_POPOVER_FILES }, (_, i) => entry(`file-${i}.ts`))
    const result = buildFileList('app/src/main', entries)
    expect(result?.files).toHaveLength(MAX_POPOVER_FILES)
    expect(result?.overflow).toBe(0)
  })
})

describe('buildFileList — git-state join (Review Mode, #609/#629)', () => {
  function change(filePath: string, state: GitFileChange['state'], staged = false): GitFileChange {
    return { filePath, state, staged }
  }

  it('joins added/modified/untracked state onto the matching on-disk files', () => {
    const result = buildFileList(
      'src',
      [entry('a.ts'), entry('b.ts'), entry('README.md')],
      [change('src/a.ts', 'modified'), change('src/README.md', 'added'), change('src/b.ts', 'untracked')],
    )
    const byName = Object.fromEntries((result?.files ?? []).map((f) => [f.name, f.gitState]))
    expect(byName['a.ts']).toBe('modified')
    expect(byName['README.md']).toBe('added')
    expect(byName['b.ts']).toBe('untracked')
  })

  it('leaves on-disk files with no matching change without a gitState', () => {
    const result = buildFileList('src', [entry('a.ts'), entry('b.ts')], [change('src/a.ts', 'modified')])
    const b = result?.files.find((f) => f.name === 'b.ts')
    expect(b?.gitState).toBeUndefined()
  })

  it('re-surfaces a deleted file that belonged to THIS directory', () => {
    // 'src/gone.ts' is gone from disk (not in entries) but its parent dir is 'src'.
    const result = buildFileList('src', [entry('a.ts')], [change('src/gone.ts', 'deleted')])
    const gone = result?.files.find((f) => f.name === 'gone.ts')
    expect(gone).toEqual({ name: 'gone.ts', relPath: 'src/gone.ts', gitState: 'deleted' })
  })

  it('does NOT leak a deleted file from another directory into this popover (#629)', () => {
    // The deletion lives in 'other/', but we are listing 'src/' — it must not appear.
    const result = buildFileList('src', [entry('a.ts')], [
      change('other/gone.ts', 'deleted'),
      change('app/out/renderer/assets/bundle.js', 'deleted'),
    ])
    expect(result?.files.map((f) => f.relPath)).toEqual(['src/a.ts'])
  })

  it('does NOT re-surface a deletion nested deeper than this directory (#629)', () => {
    // 'src/inner/deep.ts' belongs to 'src/inner', not 'src' — a listing of 'src'
    // shows only its immediate children.
    const result = buildFileList('src', [entry('a.ts')], [change('src/inner/deep.ts', 'deleted')])
    expect(result?.files.map((f) => f.relPath)).toEqual(['src/a.ts'])
  })

  it('re-surfaces a top-level deletion only for the root ("") directory', () => {
    expect(buildFileList('', [], [change('gone.ts', 'deleted')])?.files).toEqual([
      { name: 'gone.ts', relPath: 'gone.ts', gitState: 'deleted' },
    ])
    // The same top-level deletion must NOT appear in a nested module's popover.
    expect(buildFileList('src', [entry('a.ts')], [change('gone.ts', 'deleted')])?.files).toEqual([
      { name: 'a.ts', relPath: 'src/a.ts' },
    ])
  })

  it('does not double-count a deletion still present in the on-disk listing', () => {
    const result = buildFileList('src', [entry('a.ts')], [change('src/a.ts', 'deleted')])
    expect(result?.files).toHaveLength(1)
    expect(result?.files[0]).toEqual({ name: 'a.ts', relPath: 'src/a.ts', gitState: 'deleted' })
  })

  it('counts deletions toward the cap instead of appending past it (#629)', () => {
    // 6 on-disk + 4 in-dir deletions = 10 total; capped at MAX_POPOVER_FILES(8),
    // overflow 2 — the appended deletions are INSIDE the cap, never beyond it.
    const onDisk = Array.from({ length: 6 }, (_, i) => entry(`disk-${i}.ts`))
    const deletions = Array.from({ length: 4 }, (_, i) => change(`src/del-${i}.ts`, 'deleted'))
    const result = buildFileList('src', onDisk, deletions)
    expect(result?.files).toHaveLength(MAX_POPOVER_FILES)
    expect(result?.overflow).toBe(2)
  })

  it('orders on-disk + deleted files together source-first, then alpha', () => {
    const result = buildFileList(
      'src',
      [entry('zeta.ts'), entry('notes.md')],
      [change('src/alpha.ts', 'deleted')],
    )
    expect(result?.files.map((f) => f.name)).toEqual(['alpha.ts', 'zeta.ts', 'notes.md'])
  })

  it('defaults to no changes (backward compatible two-arg call)', () => {
    const result = buildFileList('src', [entry('a.ts')])
    expect(result?.files).toEqual([{ name: 'a.ts', relPath: 'src/a.ts' }])
  })
})
