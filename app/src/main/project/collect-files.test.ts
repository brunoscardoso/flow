// Unit coverage for the PURE, fs-injected file walk behind project:listAllFiles
// (the ⌘P palette's file source). A fake DirReader drives the bounding, ignore,
// depth, ordering, and fail-soft behavior with no filesystem.

import { collectFiles, type DirReadEntry, type DirReader } from './files'

const dir = (name: string): DirReadEntry => ({ name, isDirectory: true })
const file = (name: string): DirReadEntry => ({ name, isDirectory: false })

/** A DirReader over an in-memory tree; a missing dir rejects (unreadable). */
function readerFrom(tree: Record<string, DirReadEntry[]>): DirReader {
  return async (relDir: string): Promise<DirReadEntry[]> => {
    if (!(relDir in tree)) throw new Error(`no such dir: ${relDir}`)
    return tree[relDir]
  }
}

const IGNORED = new Set(['node_modules', '.git'])

describe('collectFiles', () => {
  it('returns a sorted flat list, skipping ignored and dotfile directories', async () => {
    const read = readerFrom({
      '': [file('a.ts'), dir('src'), dir('node_modules'), dir('.git')],
      src: [file('c.ts'), file('b.ts')],
      node_modules: [file('evil.ts')],
      '.git': [file('HEAD')],
    })
    const result = await collectFiles(read, { ignoredDirs: IGNORED, limit: 100 })
    expect(result.relPaths).toEqual(['a.ts', 'src/b.ts', 'src/c.ts'])
    expect(result.truncated).toBe(false)
  })

  it('stops at the limit and reports truncated', async () => {
    const read = readerFrom({
      '': [file('a.ts'), dir('src')],
      src: [file('b.ts'), file('c.ts')],
    })
    const result = await collectFiles(read, { ignoredDirs: IGNORED, limit: 2 })
    expect(result.relPaths).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('honors the depth guard (deeper files excluded)', async () => {
    const read = readerFrom({
      '': [dir('a')],
      a: [file('f1.ts'), dir('b')],
      'a/b': [file('f2.ts')],
    })
    const result = await collectFiles(read, { ignoredDirs: IGNORED, limit: 100, maxDepth: 1 })
    expect(result.relPaths).toEqual(['a/f1.ts'])
    expect(result.truncated).toBe(false)
  })

  it('is fail-soft — an unreadable directory is skipped, not thrown', async () => {
    const read: DirReader = async (relDir) => {
      if (relDir === '') return [file('a.ts'), dir('broken')]
      throw new Error('permission denied')
    }
    const result = await collectFiles(read, { ignoredDirs: IGNORED, limit: 100 })
    expect(result.relPaths).toEqual(['a.ts'])
    expect(result.truncated).toBe(false)
  })

  it('is deterministic for the same tree and limit', async () => {
    const tree = {
      '': [file('z.ts'), dir('src'), file('a.ts')],
      src: [file('m.ts')],
    }
    const a = await collectFiles(readerFrom(tree), { ignoredDirs: IGNORED, limit: 100 })
    const b = await collectFiles(readerFrom(tree), { ignoredDirs: IGNORED, limit: 100 })
    expect(a.relPaths).toEqual(b.relPaths)
  })
})
