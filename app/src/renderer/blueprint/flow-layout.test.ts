import {
  assignLayers,
  BOX_GAP,
  compactLayers,
  BOX_H,
  COL_GAP,
  COL_W,
  FIT_BOX_MAX_W,
  FIT_BOX_MIN_W,
  FLOW_PAD,
  fitColumns,
  laneHeading,
  layoutFlow,
  orderLayers,
  type FlowEdgeInput,
  type FlowNodeInput,
} from './flow-layout'

const node = (id: string, kind = 'MODULE'): FlowNodeInput => ({ id, kind })
const edge = (from: string, to: string): FlowEdgeInput => ({ from, to })

describe('assignLayers', () => {
  it('takes the LONGEST path, so a node lands after everything it waits on', () => {
    // a → b → c and a → c. The short route would put c beside b; c waits on
    // both, so it belongs after both.
    const layers = assignLayers([node('a'), node('b'), node('c')], [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('a', 'c'),
    ])
    expect(layers.get('a')).toBe(0)
    expect(layers.get('b')).toBe(1)
    expect(layers.get('c')).toBe(2)
  })

  it('puts every source in the first column', () => {
    const layers = assignLayers([node('a'), node('b'), node('c')], [edge('a', 'c'), edge('b', 'c')])
    expect(layers.get('a')).toBe(0)
    expect(layers.get('b')).toBe(0)
    expect(layers.get('c')).toBe(1)
  })

  it('terminates on a cycle rather than hanging the render', () => {
    // A feature map is human-authored text and is allowed to be wrong; the
    // board is not allowed to freeze when it is.
    const layers = assignLayers([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')])
    expect(layers.size).toBe(2)
    for (const value of layers.values()) expect(Number.isFinite(value)).toBe(true)
  })

  it('ignores an edge whose end is not on the sheet', () => {
    const layers = assignLayers([node('a')], [edge('a', 'ghost'), edge('ghost', 'a')])
    expect(layers.get('a')).toBe(0)
    expect(layers.has('ghost')).toBe(false)
  })
})

describe('compactLayers', () => {
  it('squeezes gaps out, keeping the order', () => {
    const out = compactLayers(new Map([['a', 0], ['b', 7], ['c', 30]]))
    expect([...out.entries()]).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })

  it('keeps two nodes on the same layer together', () => {
    const out = compactLayers(new Map([['a', 4], ['b', 4], ['c', 9]]))
    expect(out.get('a')).toBe(out.get('b'))
    expect(out.get('c')).toBe(1)
  })
})

describe('orderLayers', () => {
  it('keeps the first column in input order', () => {
    const nodes = [node('a'), node('b')]
    const rows = orderLayers(nodes, [], assignLayers(nodes, []))
    expect(rows.get('a')).toBe(0)
    expect(rows.get('b')).toBe(1)
  })

  it('sits a node at the height of what feeds it', () => {
    // Sources a(0) and b(1); y is fed by b, x is fed by a. Written x-then-y,
    // the barycentre sweep swaps them so neither arrow crosses.
    const nodes = [node('a'), node('b'), node('x'), node('y')]
    const edges = [edge('a', 'x'), edge('b', 'y')]
    const layers = assignLayers(nodes, edges)
    const rows = orderLayers(nodes, edges, layers)
    expect(rows.get('x')).toBe(0)
    expect(rows.get('y')).toBe(1)
  })

  it('is stable — equal barycentres keep their input order', () => {
    const nodes = [node('a'), node('p'), node('q')]
    const edges = [edge('a', 'p'), edge('a', 'q')]
    const rows = orderLayers(nodes, edges, assignLayers(nodes, edges))
    expect(rows.get('p')).toBe(0)
    expect(rows.get('q')).toBe(1)
  })
})

describe('laneHeading', () => {
  it('names a column after the kind that dominates it', () => {
    expect(laneHeading(['DATASTORE', 'DATASTORE', 'MODULE'])).toBe('STORAGE')
    expect(laneHeading(['ENDPOINT'])).toBe('API SURFACE')
    expect(laneHeading(['FUNCTION'])).toBe('LOGIC')
  })

  it('keeps an unmapped kind rather than inventing a category for it', () => {
    // A wrong category is worse than a plain one — the reader can check a kind
    // against the card below it and cannot check a word nothing produced.
    expect(laneHeading(['WIDGET'])).toBe('WIDGET')
  })

  it('says something for an empty column', () => {
    expect(laneHeading([])).toBe('STAGE')
  })
})

describe('layoutFlow', () => {
  const nodes = [node('a', 'MODULE'), node('b', 'ENDPOINT'), node('c', 'DATASTORE')]
  const edges = [edge('a', 'b'), edge('b', 'c')]

  it('draws an empty level as an empty sheet rather than throwing', () => {
    expect(layoutFlow([], [])).toEqual({ boxes: [], lanes: [], arrows: [], width: 0, height: 0 })
  })

  it('puts each layer in its own column, left to right', () => {
    const out = layoutFlow(nodes, edges)
    const x = (id: string) => out.boxes.find((box) => box.id === id)?.rect.x ?? -1
    expect(x('b') - x('a')).toBe(COL_W + COL_GAP)
    expect(x('c') - x('b')).toBe(COL_W + COL_GAP)
  })

  it('stacks a column and never overlaps two boxes', () => {
    const out = layoutFlow([node('a'), node('b'), node('c')], [])
    const ys = out.boxes.map((box) => box.rect.y).sort((p, q) => p - q)
    expect(ys[1]! - ys[0]!).toBe(BOX_H + BOX_GAP)
    for (const one of out.boxes)
      for (const other of out.boxes) {
        if (one.id === other.id) continue
        const overlap =
          Math.min(one.rect.x + one.rect.w, other.rect.x + other.rect.w) -
            Math.max(one.rect.x, other.rect.x) >
            0 &&
          Math.min(one.rect.y + one.rect.h, other.rect.y + other.rect.h) -
            Math.max(one.rect.y, other.rect.y) >
            0
        expect(overlap).toBe(false)
      }
  })

  it('gives every column a heading derived from what stands in it', () => {
    const out = layoutFlow(nodes, edges)
    expect(out.lanes.map((lane) => lane.heading)).toEqual(['INTERFACE', 'API SURFACE', 'STORAGE'])
    // …and carries what it counted, so the surface can admit the guess.
    expect(out.lanes[0]?.kinds).toEqual(['MODULE'])
  })

  it('marks every arrow forward on a graph that only goes forward', () => {
    expect(layoutFlow(nodes, edges).arrows.every((arrow) => !arrow.back)).toBe(true)
  })

  it('routes a non-forward edge as a detour instead of through the boxes', () => {
    // A non-forward arrow can only come from a cycle: layering gives every
    // other edge a positive step by construction. Two mutually-calling nodes
    // are the smallest honest case.
    const out = layoutFlow([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')])
    const backward = out.arrows.filter((arrow) => arrow.back)
    expect(backward.length).toBeGreaterThan(0)
    // The detour drops below every box it passes.
    const lowest = Math.max(...out.boxes.map((box) => box.rect.y + box.rect.h))
    for (const arrow of backward) expect(arrow.labelY).toBeGreaterThanOrEqual(lowest)
  })

  it('drops an edge whose end is not drawn, rather than pointing at nothing', () => {
    const out = layoutFlow(nodes, [...edges, edge('a', 'nowhere')])
    expect(out.arrows).toHaveLength(2)
  })

  it('wraps a long chain into bands rather than running off the pane', () => {
    // Seven stages is the honest answer to "what happens in what order" and it
    // is also 1,880px, which no pane has. The stage ORDER is untouched; only
    // where the page breaks.
    const chain = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => node(id))
    const links = chain.slice(1).map((n, i) => edge(chain[i]!.id, n.id))
    const out = layoutFlow(chain, links, { maxColumns: 4 })
    const at = (id: string) => out.boxes.find((b) => b.id === id)!
    expect(at('a').band).toBe(0)
    expect(at('d').band).toBe(0)
    expect(at('e').band).toBe(1)
    expect(at('e').column).toBe(0) // …and back to the left edge
    expect(at('e').rect.x).toBe(at('a').rect.x)
    expect(at('e').rect.y).toBeGreaterThan(at('a').rect.y)
    // Four columns wide, never seven.
    expect(new Set(out.boxes.map((b) => b.rect.x)).size).toBe(4)
  })

  it('routes the wrap as a detour, not straight back across the band', () => {
    const chain = ['a', 'b', 'c'].map((id) => node(id))
    const links = [edge('a', 'b'), edge('b', 'c')]
    const out = layoutFlow(chain, links, { maxColumns: 2 })
    const wrap = out.arrows.find((arrow) => arrow.from === 'b' && arrow.to === 'c')
    expect(wrap?.back).toBe(true)
  })

  it('never leaves an empty band between two full ones', () => {
    // A cycle drives the raw layer numbers up; without compaction those gaps
    // become bands with a heading, a box's height and nothing in them.
    const nodes2 = ['a', 'b', 'c', 'd'].map((id) => node(id))
    const out = layoutFlow(nodes2, [edge('a', 'b'), edge('b', 'a'), edge('c', 'd')], {
      maxColumns: 2,
    })
    const bands = [...new Set(out.boxes.map((box) => box.band))].sort((p, q) => p - q)
    // Consecutive from zero: no band exists that holds nothing.
    expect(bands).toEqual(bands.map((_, index) => index))
  })

  it('leaves a chain that fits alone', () => {
    const out = layoutFlow(nodes, edges, { maxColumns: 10 })
    expect(out.boxes.every((box) => box.band === 0)).toBe(true)
  })

  it('is tall enough to hold the arrows it routed below the boxes', () => {
    // A detour dips BELOW the boxes and carries its label there. A canvas sized
    // to the boxes alone ends above its own arrows, and those labels spill onto
    // whatever the level draws next — live, onto the changes strip.
    const out = layoutFlow([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')])
    const deepest = Math.max(...out.arrows.map((arrow) => arrow.labelY))
    expect(out.height).toBeGreaterThan(deepest)
  })

  it('leaves a lane between stacked boxes wide enough for a label', () => {
    // Every gap in the layout is sized by what has to fit THROUGH it. A label
    // is ~13px of chip; a gap narrower than that has nowhere for one to go, and
    // the placement pass can only move a label to a clear spot that exists.
    const out = layoutFlow([node('a'), node('b')], [])
    const [first, second] = out.boxes.map((box) => box.rect.y).sort((p, q) => p - q)
    expect(second! - (first! + BOX_H)).toBeGreaterThanOrEqual(30)
  })

  it('is deterministic — same input, same geometry', () => {
    expect(layoutFlow(nodes, edges)).toEqual(layoutFlow(nodes, edges))
  })

  it('is as wide and as tall as its own content', () => {
    const out = layoutFlow(nodes, edges)
    expect(out.width).toBeGreaterThan(3 * COL_W)
    expect(out.height).toBeGreaterThan(BOX_H)
  })
})


describe('layoutFlow — fitted to the stage', () => {
  const chain = [node('a'), node('b')]
  const edge: FlowEdgeInput[] = [{ from: 'a', to: 'b' }]

  it('keeps the historical 208 x 70 grid when no fit is asked for', () => {
    const box = layoutFlow(chain, edge).boxes[0]
    expect([box.rect.w, box.rect.h]).toEqual([COL_W, BOX_H])
  })

  it('grows the boxes with the stage, and they differ between a narrow and a wide pane', () => {
    // The live complaint: every card was 208 x 70 at 1,000px and at 2,200px.
    const narrow = layoutFlow(chain, edge, { fitWidth: 700 }).boxes[0].rect.w
    const wide = layoutFlow(chain, edge, { fitWidth: 1223 }).boxes[0].rect.w
    expect(wide).toBeGreaterThan(narrow)
    expect(narrow).toBeGreaterThanOrEqual(FIT_BOX_MIN_W)
    expect(wide).toBeLessThanOrEqual(FIT_BOX_MAX_W)
  })

  it('wraps to one column when two boxes cannot fit side by side', () => {
    const fit = fitColumns(400, 2)
    expect(fit.columns).toBe(1)
    expect(fit.boxWidth).toBe(FIT_BOX_MAX_W)
  })

  it('never shrinks a box below the floor on a stage narrower than one box', () => {
    // The canvas scrolls; a box squeezed below the floor wraps its title into
    // unreadable single words instead.
    expect(fitColumns(200, 2)).toEqual({ columns: 1, boxWidth: FIT_BOX_MIN_W })
  })

  it('never lays out more columns than there are stages', () => {
    expect(fitColumns(5000, 2).columns).toBe(2)
  })

  it('gives every box the requested height, so a claim band has room below the title', () => {
    const layout = layoutFlow(chain, edge, { fitWidth: 1223, boxHeight: 188 })
    expect(layout.boxes.every((box) => box.rect.h === 188)).toBe(true)
    // Lanes and the sheet are sized from the same box, or arrows land on cards.
    expect(layout.width).toBe(FLOW_PAD * 2 + 2 * layout.boxes[0].rect.w + COL_GAP)
  })
})

describe('layoutFlow — one stage is a grid, not a column', () => {
  // Live: a discovery predicting 8 components with no wiring drew ONE column
  // of 8 cards two thousand pixels deep, the rest of the pane empty.
  const eight = Array.from({ length: 8 }, (_, i) => node(`n${String(i)}`))

  it('spreads a single stage across the stage width', () => {
    const layout = layoutFlow(eight, [], { fitWidth: 1100 })
    const columns = new Set(layout.boxes.map((box) => box.rect.x)).size
    expect(columns).toBeGreaterThan(1)
    expect(layout.width).toBeLessThanOrEqual(1100)
    expect(layout.arrows).toEqual([])
  })

  it('never overlaps two cards', () => {
    const boxes = layoutFlow(eight, [], { fitWidth: 1100, boxHeight: 162 }).boxes
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue
        const apart =
          a.rect.x + a.rect.w <= b.rect.x ||
          b.rect.x + b.rect.w <= a.rect.x ||
          a.rect.y + a.rect.h <= b.rect.y ||
          b.rect.y + b.rect.h <= a.rect.y
        expect(apart).toBe(true)
      }
    }
  })

  it('keeps the stacked flow when stages are connected', () => {
    // Positive: with an edge there are two stages, and they stay side by side.
    const layout = layoutFlow([node('a'), node('b')], [{ from: 'a', to: 'b' }], { fitWidth: 1100 })
    expect(layout.arrows).toHaveLength(1)
  })
})
