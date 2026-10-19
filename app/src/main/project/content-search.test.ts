// Unit coverage for the PURE, fs-injected content search behind
// project:searchContent. An in-memory DirReader + FileTextReader drive the
// walk, matching, caps, and skip behavior with no filesystem — mirrors
// collect-files.test.ts.

import { searchFiles, type FileTextReader } from './content-search'
import type { DirReadEntry, DirReader } from './files'

const dir = (name: string): DirReadEntry => ({ name, isDirectory: true })
const file = (name: string): DirReadEntry => ({ name, isDirectory: false })

/** A DirReader over an in-memory tree; a missing dir rejects (unreadable). */
function readerFrom(tree: Record<string, DirReadEntry[]>): DirReader {
  return async (relDir: string): Promise<DirReadEntry[]> => {
    if (!(relDir in tree)) throw new Error(`no such dir: ${relDir}`)
    return tree[relDir]
  }
}

/** A FileTextReader over an in-memory file map; a missing entry means SKIP. */
function textFrom(files: Record<string, string | null>): FileTextReader {
  return async (relPath: string): Promise<string | null> =>
    relPath in files ? files[relPath] : null
}

const IGNORED = new Set(['node_modules', '.git'])

const baseOpts = {
  ignoredDirs: IGNORED,
  maxResults: 100,
  maxPerFile: 50,
  fileScanLimit: 1000,
}

describe('searchFiles', () => {
  it('finds a literal substring across files, sorted by path', async () => {
    const read = readerFrom({
      '': [file('a.ts'), dir('src')],
      src: [file('b.ts'), file('c.ts')],
    })
    const text = textFrom({
      'a.ts': 'const needle = 1',
      'src/b.ts': 'no match here',
      'src/c.ts': 'another needle line',
    })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle' })
    expect(result.files.map((f) => f.relPath)).toEqual(['a.ts', 'src/c.ts'])
    expect(result.files[0].matches[0]).toEqual({ line: 1, column: 6, preview: 'const needle = 1' })
    expect(result.truncated).toBe(false)
  })

  it('is case-insensitive by default and case-sensitive when asked', async () => {
    const read = readerFrom({ '': [file('a.ts')] })
    const text = textFrom({ 'a.ts': 'Foo FOO foo' })

    const ci = await searchFiles(read, text, { ...baseOpts, query: 'foo' })
    expect(ci.files[0].matches).toHaveLength(1)
    expect(ci.files[0].matches[0].column).toBe(0)

    const cs = await searchFiles(read, text, { ...baseOpts, query: 'foo', caseSensitive: true })
    expect(cs.files[0].matches[0].column).toBe(8)
  })

  it('records the correct 1-based line, 0-based column, and multiple lines', async () => {
    const read = readerFrom({ '': [file('a.ts')] })
    const text = textFrom({ 'a.ts': 'line one\n  target here\nlast target' })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'target' })
    expect(result.files[0].matches).toEqual([
      { line: 2, column: 2, preview: '  target here' },
      { line: 3, column: 5, preview: 'last target' },
    ])
  })

  it('skips ignored and dotfile directories', async () => {
    const read = readerFrom({
      '': [file('a.ts'), dir('node_modules'), dir('.git')],
      node_modules: [file('evil.ts')],
      '.git': [file('HEAD')],
    })
    const text = textFrom({
      'a.ts': 'needle',
      'node_modules/evil.ts': 'needle',
      '.git/HEAD': 'needle',
    })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle' })
    expect(result.files.map((f) => f.relPath)).toEqual(['a.ts'])
  })

  it('skips files the reader returns null for (binary / oversized)', async () => {
    const read = readerFrom({ '': [file('a.ts'), file('big.bin')] })
    const text = textFrom({ 'a.ts': 'needle', 'big.bin': null })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle' })
    expect(result.files.map((f) => f.relPath)).toEqual(['a.ts'])
  })

  it('caps matches per file', async () => {
    const read = readerFrom({ '': [file('a.ts')] })
    const text = textFrom({ 'a.ts': 'x\nx\nx\nx\nx' })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'x', maxPerFile: 2 })
    expect(result.files[0].matches).toHaveLength(2)
  })

  it('caps total matches and reports truncated', async () => {
    const read = readerFrom({ '': [file('a.ts'), file('b.ts')] })
    const text = textFrom({ 'a.ts': 'hit\nhit', 'b.ts': 'hit' })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'hit', maxResults: 2 })
    const total = result.files.reduce((n, f) => n + f.matches.length, 0)
    expect(total).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('reports truncated when the file-scan limit is hit', async () => {
    const read = readerFrom({ '': [file('a.ts'), file('b.ts'), file('c.ts')] })
    const text = textFrom({ 'a.ts': 'no', 'b.ts': 'no', 'c.ts': 'needle' })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle', fileScanLimit: 2 })
    // Only a.ts and b.ts were scanned; c.ts (the only match) was never reached.
    expect(result.files).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('returns nothing for an empty or whitespace-only query without walking', async () => {
    const read: DirReader = async () => {
      throw new Error('should not be called')
    }
    const text: FileTextReader = async () => {
      throw new Error('should not be called')
    }
    expect(await searchFiles(read, text, { ...baseOpts, query: '' })).toEqual({
      files: [],
      truncated: false,
    })
    expect(await searchFiles(read, text, { ...baseOpts, query: '   ' })).toEqual({
      files: [],
      truncated: false,
    })
  })

  it('trims a preview to previewMaxChars and handles CRLF lines', async () => {
    const read = readerFrom({ '': [file('a.ts')] })
    const long = 'needle' + 'y'.repeat(500)
    const text = textFrom({ 'a.ts': `${long}\r\nsecond needle\r\n` })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle', previewMaxChars: 20 })
    // The long first line is trimmed to previewMaxChars.
    expect(result.files[0].matches[0].preview).toBe('needle' + 'y'.repeat(14))
    // The short second line is untouched, and the CRLF's trailing \r is stripped.
    expect(result.files[0].matches[1].preview).toBe('second needle')
  })

  it('is fail-soft — an unreadable directory is skipped, not thrown', async () => {
    const read: DirReader = async (relDir) => {
      if (relDir === '') return [file('a.ts'), dir('broken')]
      throw new Error('permission denied')
    }
    const text = textFrom({ 'a.ts': 'needle' })
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle' })
    expect(result.files.map((f) => f.relPath)).toEqual(['a.ts'])
  })

  // #1910: files are read in parallel batches (SEARCH_READ_CONCURRENCY = 24). The
  // early-stop must not depend on which read finishes first — with reads that
  // resolve out of order, the maxResults cap must still land on the SAME files a
  // deterministic candidate-order walk would keep.
  it('honors maxResults in candidate order even when reads resolve out of order', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
    const read = readerFrom({ '': names.map(file) })
    // Every file matches once; later files resolve FASTER (reverse-staggered), so
    // completion order is the opposite of candidate order.
    const slowText: FileTextReader = (relPath) => {
      const idx = names.indexOf(relPath)
      return new Promise((resolveText) => setTimeout(() => resolveText('hit'), (names.length - idx) * 2))
    }
    const result = await searchFiles(read, slowText, {
      ...baseOpts,
      query: 'hit',
      maxResults: 5,
    })
    // The first 5 candidates in path order are kept — not whichever 5 read first.
    expect(result.files.map((f) => f.relPath)).toEqual([
      'f00.ts',
      'f01.ts',
      'f02.ts',
      'f03.ts',
      'f04.ts',
    ])
    expect(result.truncated).toBe(true)
  })

  it('scans a batch of files concurrently and returns them all sorted', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
    const read = readerFrom({ '': names.map(file) })
    // Only the odd-indexed files match; all are read in parallel batches.
    const text = textFrom(
      Object.fromEntries(names.map((n, i) => [n, i % 2 === 1 ? 'needle here' : 'nothing'])),
    )
    const result = await searchFiles(read, text, { ...baseOpts, query: 'needle' })
    expect(result.files.map((f) => f.relPath)).toEqual(names.filter((_, i) => i % 2 === 1))
    expect(result.truncated).toBe(false)
  })
})
