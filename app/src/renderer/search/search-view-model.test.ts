// Unit coverage for the DOM-free content-search view model. Injected fakes for
// searchContent (jest.fn), the root list, and the debounce timer let the
// debounce, stale-guard, and result-flattening logic be driven synchronously
// with no DOM — mirrors palette-sources.test.ts.

import {
  SearchViewModel,
  computeHighlights,
  flattenResults,
  type SearchContentFn,
  type SearchView,
} from './search-view-model'
import type { ContentSearchResult } from '../../shared/ipc-contract'

// ── A manual timer the tests drain explicitly ────────────────────────────────
interface FakeTimer {
  fn: () => void
  cleared: boolean
}
function makeScheduler() {
  let queue: FakeTimer[] = []
  const setTimer = (fn: () => void): FakeTimer => {
    const timer: FakeTimer = { fn, cleared: false }
    queue.push(timer)
    return timer
  }
  const clearTimer = (handle: unknown): void => {
    ;(handle as FakeTimer).cleared = true
  }
  const flush = (): void => {
    const pending = queue
    queue = []
    for (const timer of pending) if (!timer.cleared) timer.fn()
  }
  return { setTimer, clearTimer, flush }
}

/** Flush pending microtasks (Promise.all + .then chains inside #execute) via a
 *  real macrotask — the model's own timer is the injected fake, so setTimeout
 *  here is free to use. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const result = (files: ContentSearchResult['files'], truncated = false): ContentSearchResult => ({
  files,
  truncated,
})

describe('computeHighlights', () => {
  it('finds all case-insensitive ranges', () => {
    expect(computeHighlights('Foo foo FOO', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ])
  })

  it('respects case sensitivity when asked', () => {
    expect(computeHighlights('Foo foo', 'foo', true)).toEqual([{ start: 4, end: 7 }])
  })

  it('returns nothing for an empty query or no match', () => {
    expect(computeHighlights('anything', '')).toEqual([])
    expect(computeHighlights('anything', 'zzz')).toEqual([])
  })
})

describe('flattenResults', () => {
  it('emits a file header row then its match rows, with 1-based column', () => {
    const flat = flattenResults('needle', [
      {
        rootPath: '/r',
        result: result([
          { relPath: 'a.ts', matches: [{ line: 1, column: 6, preview: 'const needle = 1' }] },
        ]),
      },
    ])
    expect(flat.fileCount).toBe(1)
    expect(flat.totalMatches).toBe(1)
    expect(flat.rows[0]).toEqual({ kind: 'file', rootPath: '/r', relPath: 'a.ts', matchCount: 1 })
    expect(flat.rows[1]).toMatchObject({
      kind: 'match',
      rootPath: '/r',
      relPath: 'a.ts',
      line: 1,
      column: 7, // backend's 0-based 6 → 1-based 7
      preview: 'const needle = 1',
      highlights: [{ start: 6, end: 12 }],
    })
  })

  it('merges multiple roots and carries truncation', () => {
    const flat = flattenResults('x', [
      { rootPath: '/a', result: result([{ relPath: 'p.ts', matches: [{ line: 1, column: 0, preview: 'x' }] }]) },
      { rootPath: '/b', result: result([{ relPath: 'q.ts', matches: [{ line: 2, column: 0, preview: 'x' }] }], true) },
    ])
    expect(flat.fileCount).toBe(2)
    expect(flat.totalMatches).toBe(2)
    expect(flat.truncated).toBe(true)
    expect(flat.rows.map((r) => (r.kind === 'file' ? r.relPath : `${r.line}`))).toEqual([
      'p.ts',
      '1',
      'q.ts',
      '2',
    ])
  })
})

describe('SearchViewModel', () => {
  it('resets to idle on an empty query without calling searchContent', () => {
    const searchContent = jest.fn<ReturnType<SearchContentFn>, Parameters<SearchContentFn>>()
    const updates: SearchView[] = []
    const { setTimer, clearTimer, flush } = makeScheduler()
    const vm = new SearchViewModel({
      searchContent,
      getRoots: () => ['/r'],
      onUpdate: (v) => updates.push(v),
      setTimer,
      clearTimer,
    })
    vm.runQuery('   ')
    flush()
    expect(searchContent).not.toHaveBeenCalled()
    expect(updates.at(-1)?.state).toBe('idle')
  })

  it('debounces — rapid keystrokes collapse to a single search of the last query', async () => {
    const searchContent = jest
      .fn<ReturnType<SearchContentFn>, Parameters<SearchContentFn>>()
      .mockResolvedValue(result([]))
    const { setTimer, clearTimer, flush } = makeScheduler()
    const vm = new SearchViewModel({
      searchContent,
      getRoots: () => ['/r'],
      onUpdate: () => undefined,
      setTimer,
      clearTimer,
    })
    vm.runQuery('a')
    vm.runQuery('ab')
    vm.runQuery('abc')
    flush()
    await Promise.resolve()
    expect(searchContent).toHaveBeenCalledTimes(1)
    expect(searchContent).toHaveBeenCalledWith({ rootPath: '/r', query: 'abc' })
  })

  it('drops a superseded query’s late result (stale-guard)', async () => {
    const slow = deferred<ContentSearchResult>()
    const searchContent = jest
      .fn<ReturnType<SearchContentFn>, Parameters<SearchContentFn>>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(
        result([{ relPath: 'bar.ts', matches: [{ line: 1, column: 0, preview: 'bar' }] }]),
      )
    const updates: SearchView[] = []
    const { setTimer, clearTimer, flush } = makeScheduler()
    const vm = new SearchViewModel({
      searchContent,
      getRoots: () => ['/r'],
      onUpdate: (v) => updates.push(v),
      setTimer,
      clearTimer,
    })

    vm.runQuery('foo')
    flush() // execute('foo') — awaits the slow (still pending) promise
    vm.runQuery('bar')
    flush() // execute('bar') — resolves immediately
    await tick()

    // Now the earlier 'foo' search finally resolves — it must be discarded.
    slow.resolve(result([{ relPath: 'foo.ts', matches: [{ line: 9, column: 0, preview: 'foo' }] }]))
    await tick()

    const resultViews = updates.filter((v) => v.state === 'results')
    expect(resultViews.every((v) => v.query === 'bar')).toBe(true)
    expect(updates.at(-1)?.rows.some((r) => r.kind === 'file' && r.relPath === 'foo.ts')).toBe(false)
  })

  it('emits an empty state when a query has no matches', async () => {
    const searchContent = jest
      .fn<ReturnType<SearchContentFn>, Parameters<SearchContentFn>>()
      .mockResolvedValue(result([]))
    const updates: SearchView[] = []
    const { setTimer, clearTimer, flush } = makeScheduler()
    const vm = new SearchViewModel({
      searchContent,
      getRoots: () => ['/r'],
      onUpdate: (v) => updates.push(v),
      setTimer,
      clearTimer,
    })
    vm.runQuery('zzz')
    flush()
    await tick()
    expect(updates.at(-1)?.state).toBe('empty')
  })

  it('fans out across every root', async () => {
    const searchContent = jest
      .fn<ReturnType<SearchContentFn>, Parameters<SearchContentFn>>()
      .mockResolvedValue(result([]))
    const { setTimer, clearTimer, flush } = makeScheduler()
    const vm = new SearchViewModel({
      searchContent,
      getRoots: () => ['/a', '/b'],
      onUpdate: () => undefined,
      setTimer,
      clearTimer,
    })
    vm.runQuery('needle')
    flush()
    await Promise.resolve()
    expect(searchContent).toHaveBeenCalledWith({ rootPath: '/a', query: 'needle' })
    expect(searchContent).toHaveBeenCalledWith({ rootPath: '/b', query: 'needle' })
  })
})
