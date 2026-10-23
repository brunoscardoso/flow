/**
 * The icon table's DATA — this app's jest runs under a node environment, so
 * the custom element itself cannot be rendered here. What is worth pinning is
 * the table, and one rule about it that was learned the hard way.
 */
import { ICON_FILL_PATHS, ICON_PATHS } from './icon-paths'

describe('the icon table', () => {
  it('gives the record mark a FILLED centre, because this renderer only strokes', () => {
    // The first attempt drew two concentric stroked circles. At the 14px it
    // renders at in the browser toolbar that reads as a weak double ring — a
    // generic target, not a record button. A record centre is solid by
    // definition, and a stroke-only renderer cannot say so.
    expect(ICON_FILL_PATHS.record).toBeDefined()
    expect(ICON_PATHS.record).toBeDefined()
    // The ring is stroked, the centre is filled — two different paths.
    expect(ICON_FILL_PATHS.record).not.toBe(ICON_PATHS.record)
  })

  it('is additive — no other icon gained a fill', () => {
    // Every existing glyph was drawn for a stroke-only renderer; filling one
    // silently would turn an outline into a blob.
    expect(Object.keys(ICON_FILL_PATHS)).toEqual(['record'])
  })

  it('keeps the record centre inside its ring', () => {
    // The two are drawn as separate paths, so nothing but arithmetic stops the
    // disc growing over the ring. Both are circles centred at 8 in a 16 box.
    const radiusOf = (path: string): number => {
      const match = /A([\d.]+) [\d.]+ 0/.exec(path)
      return match === null ? NaN : Number(match[1])
    }
    const ring = radiusOf(ICON_PATHS.record)
    const disc = radiusOf(ICON_FILL_PATHS.record ?? '')
    expect(ring).toBeGreaterThan(0)
    expect(disc).toBeGreaterThan(0)
    // A visible gap at 14px, not a disc that swallows its ring.
    expect(ring - disc).toBeGreaterThanOrEqual(2)
  })

  it('does not reuse a path between two icons', () => {
    // Two controls that render identically are one control as far as a reader
    // is concerned — `record` sits beside `inspect` in the browser toolbar.
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const [name, path] of Object.entries(ICON_PATHS)) {
      const already = seen.get(path)
      if (already !== undefined) collisions.push(`${name} draws the same path as ${already}`)
      seen.set(path, name)
    }
    // Collected rather than asserted one by one, because this repo's jest
    // expect takes no message argument — the list IS the message.
    expect(collisions).toEqual([])
  })
})

describe('the feature type glyphs (plan feature-type-icons)', () => {
  const ROLE_GLYPH_NAMES = [
    'role-ui',
    'role-api',
    'role-logic',
    'role-data',
    'role-config',
    'role-jobs',
    'role-integration',
    'role-service',
    'role-function',
    'role-mobile',
    'role-neutral',
  ]

  it('has all eleven, each a path on the 16-box', () => {
    const table = ICON_PATHS as Record<string, string>
    for (const name of ROLE_GLYPH_NAMES) {
      expect({ name, path: typeof table[name] }).toEqual({ name, path: 'string' })
      const numbers = (table[name] ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
      expect(numbers.every((value) => value >= 0 && value <= 16)).toBe(true)
    }
  })

  it('gained no fill — config draws its knobs as strokes', () => {
    expect(Object.keys(ICON_FILL_PATHS)).toEqual(['record'])
  })
})
