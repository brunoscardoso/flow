import {
  applyArrangement,
  arrangementKey,
  hasArrangement,
  parseArrangement,
  pruneArrangement,
  recomputeWireEndpoints,
  withOverride,
} from './node-arrangement'
import type { FlowPosition } from './flow-model'

// #1304: "maybe we can just add some features to drag and drop the [nodes] so
// the user can just organize the [nodes] on the UI and see that pattern
// manually." The automatic layout stays the starting point; this records where
// the reader moved things.

const position = (id: string, x: number, y: number): FlowPosition => ({ id, x, y, w: 100, h: 60 })

describe('applyArrangement (#1304)', () => {
  const laid = [position('module:a', 10, 10), position('module:b', 200, 10)]

  it('moves only what the user placed', () => {
    const out = applyArrangement(laid, { 'module:a': { x: 500, y: 400 } })
    expect(out[0]).toMatchObject({ id: 'module:a', x: 500, y: 400 })
    expect(out[1]).toMatchObject({ id: 'module:b', x: 200, y: 10 })
  })

  it('takes SIZE from the layout, never the store', () => {
    // A stale size would render a card that no longer matches its content.
    const out = applyArrangement(laid, { 'module:a': { x: 0, y: 0 } })
    expect(out[0]?.w).toBe(100)
    expect(out[0]?.h).toBe(60)
  })

  it('ignores an override for a node the layout did not place', () => {
    // A module that was deleted, or a ghost that resolved — an override must
    // never conjure a card.
    const out = applyArrangement(laid, { 'module:gone': { x: 9, y: 9 } })
    expect(out.map((p) => p.id)).toEqual(['module:a', 'module:b'])
  })

  it('leaves the layout untouched when nothing is arranged', () => {
    expect(applyArrangement(laid, {})).toEqual(laid)
  })
})

describe('recomputeWireEndpoints (#1304)', () => {
  it('follows the dragged node — edges must not stay behind', () => {
    const moved = applyArrangement([position('a', 0, 0), position('b', 200, 0)], {
      a: { x: 400, y: 300 },
    })
    const [edge] = recomputeWireEndpoints([{ from: 'a', to: 'b' }], moved)
    // Centre of the card at its NEW place.
    expect(edge).toMatchObject({ x1: 450, y1: 330, x2: 250, y2: 30 })
  })

  it('drops an edge whose endpoint is not on screen', () => {
    const laid = [position('a', 0, 0)]
    expect(recomputeWireEndpoints([{ from: 'a', to: 'ghost' }], laid)).toEqual([])
  })
})

describe('parseArrangement (#1304)', () => {
  it('round-trips real entries', () => {
    expect(parseArrangement('{"module:a":{"x":10,"y":20}}')).toEqual({
      'module:a': { x: 10, y: 20 },
    })
  })

  it('drops malformed entries without losing the good ones', () => {
    const raw = '{"a":{"x":1,"y":2},"b":{"x":"no","y":2},"c":null,"d":{"x":1}}'
    expect(parseArrangement(raw)).toEqual({ a: { x: 1, y: 2 } })
  })

  it('refuses non-finite coordinates, which would place a card nowhere', () => {
    expect(parseArrangement('{"a":{"x":null,"y":0}}')).toEqual({})
  })

  it('survives a corrupt store without costing the board', () => {
    expect(parseArrangement(null)).toEqual({})
    expect(parseArrangement('not json')).toEqual({})
    expect(parseArrangement('[1,2]')).toEqual({})
  })
})

describe('pruneArrangement (#1304)', () => {
  it('drops nodes the graph no longer has', () => {
    const pruned = pruneArrangement({ a: { x: 1, y: 1 }, gone: { x: 2, y: 2 } }, new Set(['a']))
    expect(pruned).toEqual({ a: { x: 1, y: 1 } })
  })
})

describe('withOverride / hasArrangement (#1304)', () => {
  it('records a drop without mutating what it was given', () => {
    const before = { a: { x: 1, y: 1 } }
    const after = withOverride(before, 'b', { x: 5, y: 6 })
    expect(after).toEqual({ a: { x: 1, y: 1 }, b: { x: 5, y: 6 } })
    expect(before).toEqual({ a: { x: 1, y: 1 } })
  })

  it('re-dropping a node replaces its place rather than stacking', () => {
    const twice = withOverride(withOverride({}, 'a', { x: 1, y: 1 }), 'a', { x: 9, y: 9 })
    expect(twice).toEqual({ a: { x: 9, y: 9 } })
  })

  it('answers whether a Reset affordance is needed', () => {
    // A manual layout with no way back is a trap.
    expect(hasArrangement({})).toBe(false)
    expect(hasArrangement({ a: { x: 0, y: 0 } })).toBe(true)
  })
})

describe('arrangementKey (#1304)', () => {
  it('scopes the store per project root', () => {
    expect(arrangementKey('/a')).not.toBe(arrangementKey('/b'))
  })
})
