import {
  FEED_DENSITY_STORAGE_KEY,
  getFeedDensity,
  onFeedDensityChanged,
  resetFeedDensityForTests,
  setFeedDensity,
} from './feed-density-controller'

// A minimal localStorage — these tests run under the app's node-env jest, where
// there is none. It also lets the last case take it away entirely.
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(seed))
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
  })
  return map
}

function removeStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage disabled')
    },
  })
}

afterEach(() => {
  resetFeedDensityForTests()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('feed density preference', () => {
  it('defaults to Compact when nothing was ever chosen', () => {
    installStorage()
    expect(getFeedDensity()).toBe('compact')
  })

  it('reads back a persisted choice', () => {
    installStorage({ [FEED_DENSITY_STORAGE_KEY]: 'detailed' })
    expect(getFeedDensity()).toBe('detailed')
  })

  it('persists a change under the app-level key', () => {
    const store = installStorage()
    setFeedDensity('balanced')
    expect(store.get(FEED_DENSITY_STORAGE_KEY)).toBe('balanced')
  })

  it('notifies live surfaces so the open conversation repaints', () => {
    installStorage()
    const seen: string[] = []
    const off = onFeedDensityChanged((density) => seen.push(density))
    setFeedDensity('detailed')
    setFeedDensity('detailed') // no-op: same value, no repaint
    setFeedDensity('compact')
    off()
    setFeedDensity('balanced')
    expect(seen).toEqual(['detailed', 'compact'])
  })

  it('ignores a stored value that is not a density', () => {
    // The key is a string in a store a person can edit; a junk value must read
    // as "never chosen", not crash the pane that asks for it.
    installStorage({ [FEED_DENSITY_STORAGE_KEY]: 'verbose' })
    expect(getFeedDensity()).toBe('compact')
  })

  it('survives storage being unavailable', () => {
    removeStorage()
    expect(getFeedDensity()).toBe('compact')
    expect(() => setFeedDensity('detailed')).not.toThrow()
    expect(getFeedDensity()).toBe('detailed')
  })
})
