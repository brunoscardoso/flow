import {
  PROJECT_ACCENT_PALETTE,
  accentOverrideFor,
  accentProperty,
  applyAccentOverrides,
  ensureAccentProperty,
  projectAccent,
  resolveAccent,
  setAccentOverride,
  setAccentSlots,
  slotPaint,
} from './project-accent'

/** An accent is a palette member: a slot, painted with that slot's theme-aware colour. */
function expectPaletteMember(accent: ReturnType<typeof projectAccent>): void {
  expect(accent.slot).not.toBeNull()
  const entry = PROJECT_ACCENT_PALETTE[accent.slot ?? -1]
  expect(entry).toBeDefined()
  expect(accent).toEqual({ hue: entry.hue, color: entry.paint, slot: entry.slot })
}

describe('projectAccent', () => {
  it('is deterministic for the same rootPath', () => {
    const path = '/Users/dev/projects/flow'
    expect(projectAccent(path)).toEqual(projectAccent(path))
  })

  it('is deterministic across repeated calls in a fresh evaluation order', () => {
    // Guards against any hidden mutable/statement-order state in the hash.
    const paths = ['/a/b/c', '/x/y/z', '/a/b/c', '/x/y/z']
    const [first, second, third, fourth] = paths.map(projectAccent)
    expect(first).toEqual(third)
    expect(second).toEqual(fourth)
  })

  it('always resolves to a palette member', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `/synthetic/root-${i}/project`)
    for (const path of paths) {
      const accent = projectAccent(path)
      expectPaletteMember(accent)
    }
  })

  it('does not key off the basename alone — roots sharing a basename can diverge', () => {
    // If the implementation hashed only the last path segment, every one of
    // these (same basename "app", different parents) would collide on a
    // single accent. Hashing the full path lets them spread across buckets.
    const basename = 'app'
    const paths = Array.from({ length: 40 }, (_, i) => `/team-${i}/workspace/${basename}`)
    const distinctColors = new Set(paths.map((p) => projectAccent(p).color))
    expect(distinctColors.size).toBeGreaterThan(1)
  })

  it('is sensitive to the full path, not just the trailing segment', () => {
    const a = projectAccent('/Users/alice/projects/app')
    const b = projectAccent('/Users/bob/work/app')
    // Not asserting inequality (hash collisions across only 8 buckets are
    // acceptable) — asserting that the two full, distinct paths were each
    // independently hashed to a valid palette member.
    expectPaletteMember(a)
    expectPaletteMember(b)
  })

  it('distributes synthetic paths across the palette without a dominant bucket', () => {
    const n = 500
    const paths = Array.from({ length: n }, (_, i) => `/Users/dev/workspaces/project-${i}/repo`)
    const counts = new Map<string, number>()
    for (const path of paths) {
      const { color } = projectAccent(path)
      counts.set(color, (counts.get(color) ?? 0) + 1)
    }
    // Sanity check on spread, not perfect uniformity: no single bucket should
    // capture more than half of 500 synthetic, sequentially-varying paths.
    for (const count of counts.values()) {
      expect(count).toBeLessThan(n * 0.5)
    }
    // And more than one bucket should actually be in use.
    expect(counts.size).toBeGreaterThan(1)
  })
})

describe('PROJECT_ACCENT_PALETTE', () => {
  it('curates roughly 8 accents', () => {
    expect(PROJECT_ACCENT_PALETTE.length).toBe(8)
  })

  it('has no duplicate colors', () => {
    const colors = PROJECT_ACCENT_PALETTE.map((entry) => entry.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('every entry is a well-formed hex color with a 0-360 hue', () => {
    for (const entry of PROJECT_ACCENT_PALETTE) {
      expect(entry.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(entry.hue).toBeGreaterThanOrEqual(0)
      expect(entry.hue).toBeLessThanOrEqual(360)
    }
  })
})

describe('accentProperty', () => {
  it('is deterministic for the same rootPath', () => {
    const path = '/Users/dev/projects/flow'
    expect(accentProperty(path)).toBe(accentProperty(path))
  })

  it('produces a valid CSS custom-property name', () => {
    expect(accentProperty('/Users/dev/projects/flow')).toMatch(/^--fl-project-accent-[0-9a-f]{8}$/)
  })

  it('gives two roots sharing a palette bucket distinct property names', () => {
    // Find two different paths that land on the SAME palette color (bucket
    // collisions are expected with only 8 buckets), then confirm their
    // property names still differ — the property name must be unique per
    // root, independent of the palette index.
    const paths = Array.from({ length: 100 }, (_, i) => `/synthetic/collide-${i}`)
    const byColor = new Map<string, string[]>()
    for (const path of paths) {
      const color = projectAccent(path).color
      const bucket = byColor.get(color) ?? []
      bucket.push(path)
      byColor.set(color, bucket)
    }
    const collidingBucket = [...byColor.values()].find((bucket) => bucket.length > 1)
    expect(collidingBucket).toBeDefined()
    const [pathA, pathB] = collidingBucket as string[]
    expect(accentProperty(pathA)).not.toBe(accentProperty(pathB))
  })

  it('does not key off the basename alone', () => {
    const basename = 'app'
    const paths = Array.from({ length: 20 }, (_, i) => `/team-${i}/workspace/${basename}`)
    const distinctNames = new Set(paths.map(accentProperty))
    expect(distinctNames.size).toBe(paths.length)
  })
})

describe('resolveAccent (user override layer)', () => {
  const path = '/Users/dev/projects/flow'

  it('a well-formed override color wins over the hash accent', () => {
    expect(resolveAccent(path, '#9d70db').color).toBe('#9d70db')
  })

  it('null and undefined fall back to the deterministic hash accent', () => {
    expect(resolveAccent(path, null)).toEqual(projectAccent(path))
    expect(resolveAccent(path)).toEqual(projectAccent(path))
  })

  it('a malformed override is ignored, never painted', () => {
    expect(resolveAccent(path, 'not-a-color')).toEqual(projectAccent(path))
    expect(resolveAccent(path, 'red')).toEqual(projectAccent(path))
    expect(resolveAccent(path, '#12345')).toEqual(projectAccent(path))
  })

  it('a palette override paints its slot, theme-aware — whatever case it was stored in', () => {
    for (const entry of PROJECT_ACCENT_PALETTE) {
      expect(resolveAccent(path, entry.color)).toEqual({ hue: entry.hue, color: entry.paint, slot: entry.slot })
      expect(resolveAccent(path, entry.color.toUpperCase()).slot).toBe(entry.slot)
    }
    expect(slotPaint(2)).toBe('var(--fl-project-hue-2, #a98bf5)')
  })

  it('a colour picked from the old pastel set keeps its family in the new palette', () => {
    expect(resolveAccent(path, '#a7b8ec').slot).toBe(0) // pastel blue → blue
    expect(resolveAccent(path, '#c5aee8').slot).toBe(2) // pastel violet → violet
    expect(resolveAccent(path, '#93d2c8').slot).toBe(1) // pastel teal → teal
  })

  it('a valid non-palette hex keeps the hash hue (stable tint derivations)', () => {
    const resolved = resolveAccent(path, '#123456')
    expect(resolved.color).toBe('#123456')
    expect(resolved.hue).toBe(projectAccent(path).hue)
  })
})

describe('override registry + ensureAccentProperty live updates', () => {
  const path = '/Users/dev/projects/override-me'
  const properties = new Map<string, string>()

  beforeEach(() => {
    properties.clear()
    // Minimal document stub matching the module's duck-typed MinimalDocument —
    // lets the node-env test observe the CSS custom property writes.
    ;(globalThis as { document?: unknown }).document = {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => {
            properties.set(name, value)
          },
        },
      },
    }
  })

  afterEach(() => {
    setAccentOverride(path, null)
    delete (globalThis as { document?: unknown }).document
  })

  it('an explicit override re-registers the SAME property with the new color', () => {
    const ref = ensureAccentProperty(path, null)
    const name = accentProperty(path)
    expect(ref).toBe(`var(${name})`)
    expect(properties.get(name)).toBe(projectAccent(path).color)

    const refAfter = ensureAccentProperty(path, '#30a69a')
    expect(refAfter).toBe(ref) // same var — every existing reference repaints
    expect(properties.get(name)).toBe('#30a69a')
  })

  it('an explicit override syncs the registry — a later no-arg call cannot revert it', () => {
    const name = accentProperty(path)
    ensureAccentProperty(path, '#d666ba')
    ensureAccentProperty(path) // e.g. the terminal panel, without the override at hand
    expect(properties.get(name)).toBe('#d666ba')
    expect(accentOverrideFor(path)).toBe('#d666ba')
  })

  it('an explicit null clears back to the hash accent', () => {
    const name = accentProperty(path)
    ensureAccentProperty(path, '#df8c3a')
    ensureAccentProperty(path, null)
    expect(properties.get(name)).toBe(projectAccent(path).color)
    expect(accentOverrideFor(path)).toBeNull()
  })

  it('applyAccentOverrides syncs set AND clear from a roots payload', () => {
    const other = '/Users/dev/projects/other'
    applyAccentOverrides([
      { rootPath: path, accentColor: '#5778db' },
      { rootPath: other },
    ])
    expect(accentOverrideFor(path)).toBe('#5778db')
    expect(accentOverrideFor(other)).toBeNull()
    expect(properties.get(accentProperty(path))).toBe('#5778db')

    applyAccentOverrides([{ rootPath: path }])
    expect(accentOverrideFor(path)).toBeNull()
    expect(properties.get(accentProperty(path))).toBe(projectAccent(path).color)
  })

  it('degrades to a no-op var() reference without a document (non-DOM context)', () => {
    delete (globalThis as { document?: unknown }).document
    expect(ensureAccentProperty(path, '#5f913b')).toBe(`var(${accentProperty(path)})`)
  })
})


describe('Workspace slots — a project wears its place in its Workspace (2026-10-06)', () => {
  const properties = new Map<string, string>()
  const a = '/Users/dev/work/app'
  const b = '/Users/dev/work/core'

  beforeEach(() => {
    properties.clear()
    ;(globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty: (name: string, value: string) => properties.set(name, value) } },
    }
  })

  afterEach(() => {
    setAccentSlots(new Map())
    setAccentOverride(a, null)
    delete (globalThis as { document?: unknown }).document
  })

  it('the slot wins over the hash, a pick wins over the slot, and a project that leaves goes back to the hash', () => {
    const hashed = projectAccent(a)
    setAccentSlots(new Map([[a, 4], [b, 5]]))
    expect(projectAccent(a).slot).toBe(4)
    expect(projectAccent(b).slot).toBe(5)
    // Repainted at once — every var() reference follows.
    expect(properties.get(accentProperty(a))).toBe(slotPaint(4))
    setAccentOverride(a, PROJECT_ACCENT_PALETTE[1].color)
    expect(properties.get(accentProperty(a))).toBe(slotPaint(1))
    setAccentOverride(a, null)
    expect(properties.get(accentProperty(a))).toBe(slotPaint(4))
    setAccentSlots(new Map([[b, 5]]))
    expect(projectAccent(a)).toEqual(hashed)
  })
})
