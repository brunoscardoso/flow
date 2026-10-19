import {
  createThreadLayoutStore,
  layoutScopeKey,
  pruneLayoutEntries,
  sameLayoutScope,
  type LayoutStorage,
} from './thread-layout-store'

interface Layout {
  sidebarOpen: boolean
}

function memoryStorage(): LayoutStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

function normalize(raw: unknown): Layout | null {
  if (typeof raw !== 'object' || raw === null) return null
  const open = (raw as Partial<Layout>).sidebarOpen
  return typeof open === 'boolean' ? { sidebarOpen: open } : null
}

function makeStore(storage: LayoutStorage | null, extra: { maxEntries?: number } = {}) {
  let clock = 0
  const warnings: string[] = []
  const store = createThreadLayoutStore<Layout>({
    namespace: 'test.layout',
    storage: () => storage,
    normalize,
    now: () => ++clock,
    warn: (message) => warnings.push(message),
    ...extra,
  })
  return { store, warnings }
}

const OPEN: Layout = { sidebarOpen: true }
const CLOSED: Layout = { sidebarOpen: false }
const fallback = (): Layout => ({ sidebarOpen: true })

describe('layoutScopeKey', () => {
  it('separates the project view from every thread, including one named "project"', () => {
    const project = layoutScopeKey({ root: '/a', threadId: null })
    const literal = layoutScopeKey({ root: '/a', threadId: 'project' })
    expect(project).not.toBe(literal)
  })

  it('separates the same thread id under different roots', () => {
    expect(layoutScopeKey({ root: '/a', threadId: 't' })).not.toBe(
      layoutScopeKey({ root: '/b', threadId: 't' }),
    )
  })

  it('sameLayoutScope compares root and thread', () => {
    expect(sameLayoutScope({ root: '/a', threadId: 't' }, { root: '/a', threadId: 't' })).toBe(true)
    expect(sameLayoutScope({ root: '/a', threadId: 't' }, { root: '/a', threadId: null })).toBe(false)
    expect(sameLayoutScope(null, { root: '/a', threadId: null })).toBe(false)
    expect(sameLayoutScope(null, null)).toBe(true)
  })
})

describe('createThreadLayoutStore', () => {
  it('round-trips a thread layout and keeps threads apart', () => {
    const { store } = makeStore(memoryStorage())
    store.write({ root: '/a', threadId: 'A' }, CLOSED)
    store.write({ root: '/a', threadId: 'B' }, OPEN)
    expect(store.read({ root: '/a', threadId: 'A' })).toEqual(CLOSED)
    expect(store.read({ root: '/a', threadId: 'B' })).toEqual(OPEN)
  })

  it('keeps the project view separate from its threads', () => {
    const { store } = makeStore(memoryStorage())
    store.write({ root: '/a', threadId: 'A' }, CLOSED)
    expect(store.read({ root: '/a', threadId: null })).toBeNull()
    store.write({ root: '/a', threadId: null }, OPEN)
    expect(store.read({ root: '/a', threadId: 'A' })).toEqual(CLOSED)
    expect(store.read({ root: '/a', threadId: null })).toEqual(OPEN)
  })

  it('a NEW thread inherits what is on screen in the same project', () => {
    const { store } = makeStore(memoryStorage())
    const resolved = store.resolve(
      { root: '/a', threadId: 'new' },
      { scope: { root: '/a', threadId: 'A' }, value: CLOSED },
      fallback,
    )
    expect(resolved).toEqual({ value: CLOSED, inherited: true })
  })

  it('a thread with its own entry ignores the screen', () => {
    const { store } = makeStore(memoryStorage())
    store.write({ root: '/a', threadId: 'B' }, OPEN)
    const resolved = store.resolve(
      { root: '/a', threadId: 'B' },
      { scope: { root: '/a', threadId: 'A' }, value: CLOSED },
      fallback,
    )
    expect(resolved).toEqual({ value: OPEN, inherited: false })
  })

  it('a new thread never inherits another project’s screen — it takes its project view', () => {
    const { store } = makeStore(memoryStorage())
    store.write({ root: '/b', threadId: null }, CLOSED)
    const resolved = store.resolve(
      { root: '/b', threadId: 'new' },
      { scope: { root: '/a', threadId: 'A' }, value: OPEN },
      () => OPEN,
    )
    expect(resolved).toEqual({ value: CLOSED, inherited: true })
  })

  it('the project view does NOT inherit the screen — it falls back', () => {
    const { store } = makeStore(memoryStorage())
    const resolved = store.resolve(
      { root: '/a', threadId: null },
      { scope: { root: '/a', threadId: 'A' }, value: CLOSED },
      () => OPEN,
    )
    expect(resolved).toEqual({ value: OPEN, inherited: true })
  })

  it('nothing saved and nothing on screen → the fallback (migration path)', () => {
    const { store } = makeStore(memoryStorage())
    expect(store.resolve({ root: '/a', threadId: 'A' }, null, () => CLOSED)).toEqual({
      value: CLOSED,
      inherited: true,
    })
  })

  it('discards a corrupt entry and a corrupt store', () => {
    const storage = memoryStorage()
    const { store } = makeStore(storage)
    storage.data.set(
      'test.layout',
      JSON.stringify({ version: 1, entries: { [layoutScopeKey({ root: '/a', threadId: 'A' })]: { at: 1, value: 7 } } }),
    )
    expect(store.read({ root: '/a', threadId: 'A' })).toBeNull()
    storage.data.set('test.layout', '{not json')
    expect(store.read({ root: '/a', threadId: 'A' })).toBeNull()
    storage.data.set('test.layout', JSON.stringify({ version: 99, entries: {} }))
    expect(store.read({ root: '/a', threadId: 'A' })).toBeNull()
  })

  it('prunes to the most recently written entries', () => {
    const { store } = makeStore(memoryStorage(), { maxEntries: 2 })
    store.write({ root: '/a', threadId: '1' }, OPEN)
    store.write({ root: '/a', threadId: '2' }, OPEN)
    store.write({ root: '/a', threadId: '1' }, CLOSED) // touch 1 → 2 is now oldest
    store.write({ root: '/a', threadId: '3' }, OPEN)
    expect(store.read({ root: '/a', threadId: '2' })).toBeNull()
    expect(store.read({ root: '/a', threadId: '1' })).toEqual(CLOSED)
    expect(store.read({ root: '/a', threadId: '3' })).toEqual(OPEN)
  })

  it('pruneLayoutEntries leaves a store under the bound untouched', () => {
    const entries = { a: { at: 1, value: 1 }, b: { at: 2, value: 2 } }
    expect(pruneLayoutEntries(entries, 5)).toBe(entries)
  })

  it('reads as "nothing saved" and warns when storage throws on read', () => {
    const throwing: LayoutStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
    }
    const { store, warnings } = makeStore(throwing)
    expect(store.read({ root: '/a', threadId: 'A' })).toBeNull()
    expect(store.resolve({ root: '/a', threadId: 'A' }, null, () => CLOSED).value).toEqual(CLOSED)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('swallows nothing silently when a write throws (quota) — warns and carries on', () => {
    const throwing: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const { store, warnings } = makeStore(throwing)
    expect(() => store.write({ root: '/a', threadId: 'A' }, OPEN)).not.toThrow()
    expect(warnings).toEqual(['flow: failed to persist thread layout'])
  })

  it('survives the storage getter itself throwing', () => {
    let warned = 0
    const store = createThreadLayoutStore<Layout>({
      namespace: 'x',
      storage: () => {
        throw new Error('blocked')
      },
      normalize,
      warn: () => {
        warned += 1
      },
    })
    expect(() => store.write({ root: '/a', threadId: 'A' }, OPEN)).not.toThrow()
    expect(store.read({ root: '/a', threadId: 'A' })).toBeNull()
    expect(warned).toBeGreaterThan(0)
  })

  it('a missing storage reads nothing and writes nothing', () => {
    const { store } = makeStore(null)
    store.write({ root: '/a', threadId: 'A' }, OPEN)
    expect(store.read({ root: '/a', threadId: 'A' })).toBeNull()
  })
})
