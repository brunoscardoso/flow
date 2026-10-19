import {
  changesStripFor,
  claimFor,
  deltaBadge,
  ghostPartNames,
  isFileCardId,
  ladderLit,
  levelWires,
  placeComponents,
  struckIn,
  wireEndpoints,
  COMPONENT_H,
  COMPONENT_W,
  EMPTY_PROVINCE_H,
  PART_GAP,
  PART_ROW_GAP,
  PART_LABEL_H,
  PART_PAD,
  DEFAULT_CHANGE_KIND,
  OWN_STRIP_NOTE,
  type LevelComponent,
  type LevelPart,
  type Rect,
} from './territory-level'
import type { CuratedEdge, CuratedLevel, CuratedNode } from './curated-view'
import type { BriefDeltaInput, BriefDeltaNode, BriefNodeProposal } from './brief-view-model'

const SHEET: Rect = { x: 0, y: 0, w: 900, h: 480 }

const part = (name: string, ...anchors: string[]): LevelPart => ({ name, anchors })

const comp = (
  id: string,
  file: string | null = null,
  delta: LevelComponent['delta'] = 'stable',
): LevelComponent => ({ id, file, delta })

/** True when `inner` sits entirely inside `outer` (a shared edge is fine). */
const within = (inner: Rect, outer: Rect): boolean => {
  const EPS = 1e-6
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  )
}

describe('claimFor', () => {
  const parts = [
    part('streamer', 'file:src/chat/stream.ts'),
    part('store', 'module:src/store'),
  ]

  it('claims a component by an EXACT file match, decoration and all', () => {
    expect(claimFor(comp('a', '`src/chat/stream.ts`'), parts)).toEqual({
      part: 'streamer',
      claim: 'file',
    })
  })

  it('claims a component by its DIRECTORY when no file matches outright', () => {
    expect(claimFor(comp('b', 'src/store/threads.ts'), parts)).toEqual({
      part: 'store',
      claim: 'module',
    })
  })

  it('leaves a component nobody names UNCLAIMED, on the feature itself', () => {
    expect(claimFor(comp('c', 'src/elsewhere/thing.ts'), parts)).toEqual({
      part: null,
      claim: 'unclaimed',
    })
  })

  it('leaves a component with no file at all unclaimed', () => {
    expect(claimFor(comp('d', null), parts)).toEqual({ part: null, claim: 'unclaimed' })
  })

  it('prefers an exact file match over a directory match on ANOTHER part', () => {
    // `broad` owns the whole directory; `narrow` names the one file. The finer
    // evidence must win even though `broad` is declared first.
    const ordered = [part('broad', 'module:src/chat'), part('narrow', 'file:src/chat/stream.ts')]
    expect(claimFor(comp('a', 'src/chat/stream.ts'), ordered)).toEqual({
      part: 'narrow',
      claim: 'file',
    })
  })

  it('falls back to a component’s refs when it names no file', () => {
    const withRefs: LevelComponent = {
      id: 'r',
      file: null,
      refs: ['src/store/threads.ts'],
      delta: 'stable',
    }
    expect(claimFor(withRefs, parts)).toEqual({ part: 'store', claim: 'module' })
  })

  it('claims a DERIVED component by its own id — the commonest level there is', () => {
    // A derived level's components carry no excerpt and no refs; the id IS the
    // address. Without this every component would sit on the own strip.
    const exact: LevelComponent = { id: 'module:src/store', file: null, delta: 'stable' }
    expect(claimFor(exact, parts)).toEqual({ part: 'store', claim: 'file' })
    const inside: LevelComponent = { id: 'file:src/store/threads.ts', file: null, delta: 'stable' }
    expect(claimFor(inside, parts)).toEqual({ part: 'store', claim: 'module' })
  })

  it('never claims an AUTHORED component by its invented name', () => {
    const authored: LevelComponent = { id: 'store', file: null, delta: 'stable' }
    expect(claimFor(authored, [part('store', 'store')])).toEqual({
      part: null,
      claim: 'unclaimed',
    })
  })

  it('settles a tie in DECLARATION order, not iteration order', () => {
    const both = [part('first', 'module:src/x'), part('second', 'module:src/x')]
    expect(claimFor(comp('a', 'src/x/a.ts'), both).part).toBe('first')
  })
})

describe('placeComponents', () => {
  const parts = [part('streamer', 'file:src/chat/stream.ts'), part('store', 'module:src/store')]
  const components = [
    comp('a', 'src/chat/stream.ts'),
    comp('b', 'src/store/threads.ts'),
    comp('c', 'src/elsewhere/thing.ts'),
  ]

  it('puts each component in the part that claims it', () => {
    const ground = placeComponents(parts, components, { rect: SHEET, feature: 'Chats' })
    const byId = new Map(ground.components.map((entry) => [entry.id, entry]))
    expect(byId.get('a')?.part).toBe('streamer')
    expect(byId.get('b')?.part).toBe('store')
    expect(byId.get('c')?.part).toBeNull()
  })

  it('draws every component INSIDE its part’s inner rect', () => {
    const ground = placeComponents(parts, components, { rect: SHEET, feature: 'Chats' })
    for (const province of ground.parts) {
      for (const card of province.components) {
        expect(within(card.rect, province.inner)).toBe(true)
      }
    }
  })

  it('keeps the part: null strip even when every component is claimed', () => {
    const ground = placeComponents(parts, components.slice(0, 2), {
      rect: SHEET,
      feature: 'Chats',
    })
    const own = ground.parts.find((province) => province.part === null)
    expect(own).toBeDefined()
    expect(own?.components).toEqual([])
    expect(own?.label).toBe('Chats · own anchors')
    expect(own?.note).toBe(OWN_STRIP_NOTE)
  })

  it('keeps the part: null strip when there are no parts and no components', () => {
    const ground = placeComponents([], [], { rect: SHEET, feature: 'Chats' })
    expect(ground.parts.map((province) => province.part)).toEqual([null])
  })

  it('gives every province the full width and the rows its cards need (2026-08-28)', () => {
    // Six cards in one part, none in the other: the first cut sized the
    // provinces by anchor count and crushed six cards into whatever that
    // bought; rows give the crowded part more HEIGHT and both the same width.
    const crowded = [part('busy', 'a.ts'), part('empty', 'x.ts', 'y.ts', 'z.ts')]
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => comp(id, 'a.ts'))
    const ground = placeComponents(crowded, six, { rect: SHEET, feature: 'F' })
    const busy = ground.parts.find((entry) => entry.part === 'busy')!
    const empty = ground.parts.find((entry) => entry.part === 'empty')!
    expect(busy.rect.w).toBe(empty.rect.w)
    expect(busy.rect.w).toBe(SHEET.w - PART_GAP)
    expect(busy.rect.h).toBeGreaterThan(empty.rect.h)
    expect(empty.rect.h).toBe(PART_LABEL_H + EMPTY_PROVINCE_H + PART_PAD)
    // Every card keeps its full size — the province grew instead.
    for (const card of busy.components) {
      expect(card.rect.w).toBe(COMPONENT_W)
      expect(card.rect.h).toBe(COMPONENT_H)
    }
  })

  it('wraps cards to the width and grows the ground rather than crushing them', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => comp(id, 'a.ts'))
    const wide = placeComponents([part('p', 'a.ts')], six, { rect: SHEET, feature: 'F' })
    const narrow = placeComponents([part('p', 'a.ts')], six, {
      rect: { x: 0, y: 0, w: 420, h: 480 },
      feature: 'F',
    })
    const rowsOf = (cards: readonly { rect: Rect }[]): number =>
      new Set(cards.map((card) => card.rect.y.toFixed(3))).size
    expect(rowsOf(wide.components)).toBeLessThan(rowsOf(narrow.components))
    expect(narrow.height).toBeGreaterThan(wide.height)
    // A ground with more rows than the offered rect can hold is TALLER than it.
    const tall = placeComponents(
      [part('p', 'a.ts')],
      Array.from({ length: 30 }, (_, i) => comp(`c${String(i)}`, 'a.ts')),
      { rect: { x: 0, y: 0, w: 420, h: 200 }, feature: 'F' },
    )
    expect(tall.height).toBeGreaterThan(200)
    for (const card of tall.components) expect(card.rect.w).toBe(COMPONENT_W)
  })

  it('stacks provinces top to bottom in declaration order, own strip last, never overlapping', () => {
    const ground = placeComponents(parts, components, { rect: SHEET, feature: 'Chats' })
    expect(ground.parts.map((province) => province.part)).toEqual(['streamer', 'store', null])
    for (let i = 1; i < ground.parts.length; i += 1) {
      const above = ground.parts[i - 1].rect
      const below = ground.parts[i].rect
      // THE LANE IS SIZED FOR THE WIRE LABELS THAT LAND IN IT — a wire between
      // two provinces puts its text at their midpoint, and at PART_GAP that
      // text sat on the next province's label row.
      expect(below.y).toBeGreaterThanOrEqual(above.y + above.h + PART_ROW_GAP - 1e-6)
    }
    const last = ground.parts[ground.parts.length - 1].rect
    expect(ground.height).toBeCloseTo(last.y + last.h + PART_GAP / 2, 6)
  })

  it('never overlaps two provinces', () => {
    const ground = placeComponents(parts, components, { rect: SHEET, feature: 'Chats' })
    const rects = ground.parts.map((province) => province.rect)
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]
        const b = rects[j]
        const hit =
          a.x + a.w > b.x + 1e-6 && b.x + b.w > a.x + 1e-6 && a.y + a.h > b.y + 1e-6 && b.y + b.h > a.y + 1e-6
        expect(hit).toBe(false)
      }
    }
  })

  it('caps a card at 190 × 58 however much room its part has', () => {
    const ground = placeComponents([part('solo', 'a.ts')], [comp('a', 'a.ts')], {
      rect: SHEET,
      feature: 'F',
    })
    const card = ground.components[0]
    expect(card.rect.w).toBeLessThanOrEqual(COMPONENT_W)
    expect(card.rect.h).toBeLessThanOrEqual(COMPONENT_H)
  })

  it('dashes a province only when the ghost set names it', () => {
    const plain = placeComponents(parts, [], { rect: SHEET, feature: 'Chats' })
    expect(plain.parts.every((province) => !province.ghost)).toBe(true)

    const ghosted = placeComponents(parts, [], {
      rect: SHEET,
      feature: 'Chats',
      ghostParts: new Set(['store']),
    })
    expect(ghosted.parts.find((province) => province.part === 'store')?.ghost).toBe(true)
    expect(ghosted.parts.find((province) => province.part === 'streamer')?.ghost).toBe(false)
  })

  it('keeps a ghost province’s box in Today and marks it absent — one layout, two states', () => {
    const today = placeComponents(parts, [], {
      rect: SHEET,
      feature: 'Chats',
      time: 'now',
      ghostParts: new Set(['store']),
    })
    const after = placeComponents(parts, [], {
      rect: SHEET,
      feature: 'Chats',
      time: 'next',
      ghostParts: new Set(['store']),
    })
    const rectOf = (ground: typeof today, name: string): Rect | undefined =>
      ground.parts.find((province) => province.part === name)?.rect
    expect(rectOf(today, 'store')).toEqual(rectOf(after, 'store'))
    expect(rectOf(today, 'streamer')).toEqual(rectOf(after, 'streamer'))
    expect(today.parts.find((province) => province.part === 'store')?.absent).toBe(true)
    expect(after.parts.find((province) => province.part === 'store')?.absent).toBe(false)
  })

  it('never marks an ordinary province absent', () => {
    const ground = placeComponents(parts, [], { rect: SHEET, feature: 'Chats', time: 'now' })
    expect(ground.parts.every((province) => !province.absent)).toBe(true)
  })

  it('never dashes the feature’s own strip', () => {
    const ground = placeComponents(parts, [], {
      rect: SHEET,
      feature: 'Chats',
      ghostParts: new Set(['Chats', 'store']),
    })
    expect(ground.parts.find((province) => province.part === null)?.ghost).toBe(false)
  })

  it('badges and strikes only in After', () => {
    const deltas = [comp('n', 'a.ts', 'new'), comp('m', 'b.ts', 'modify'), comp('r', 'c.ts', 'remove')]
    const today = placeComponents([], deltas, { rect: SHEET, feature: 'F', time: 'now' })
    expect(today.components.map((card) => card.badge)).toEqual([null, null, null])
    expect(today.components.map((card) => card.struck)).toEqual([false, false, false])

    const after = placeComponents([], deltas, { rect: SHEET, feature: 'F', time: 'next' })
    expect(after.components.map((card) => card.badge)).toEqual(['NEW', 'MODIFY', 'REMOVE'])
    expect(after.components.map((card) => card.struck)).toEqual([false, false, true])
  })

  it('drops a duplicate part name first-wins rather than doubling its ground', () => {
    const dupes = [part('same', 'a.ts'), part('same', 'b.ts')]
    const ground = placeComponents(dupes, [], { rect: SHEET, feature: 'F' })
    expect(ground.parts.map((province) => province.part)).toEqual(['same', null])
  })

  it('is deterministic — same input, identical output', () => {
    const once = placeComponents(parts, components, { rect: SHEET, feature: 'Chats' })
    const twice = placeComponents(parts, components, { rect: SHEET, feature: 'Chats' })
    expect(twice).toEqual(once)
  })

  it('never throws on a degenerate rect', () => {
    for (const rect of [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: -40, h: 90 },
      { x: 0, y: 0, w: 4, h: 3 },
    ]) {
      expect(() => placeComponents(parts, components, { rect, feature: 'F' })).not.toThrow()
      const ground = placeComponents(parts, components, { rect, feature: 'F' })
      for (const card of ground.components) {
        expect(card.rect.w).toBeGreaterThanOrEqual(0)
        expect(card.rect.h).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('wireEndpoints / levelWires', () => {
  const parts = [part('one', 'a.ts'), part('two', 'b.ts')]
  const ground = placeComponents(parts, [comp('a', 'a.ts'), comp('b', 'b.ts')], {
    rect: SHEET,
    feature: 'F',
  })

  it('gives a centre per placed card', () => {
    const centres = wireEndpoints(ground.components)
    expect([...centres.keys()].sort()).toEqual(['a', 'b'])
    const card = ground.components[0]
    expect(centres.get('a')).toEqual({
      x: card.rect.x + card.rect.w / 2,
      y: card.rect.y + card.rect.h / 2,
    })
  })

  it('carries kept / added / removed through from the curated edges', () => {
    const edges: CuratedEdge[] = [
      { from: 'a', to: 'b', label: 'kept one', delta: 'kept' },
      { from: 'a', to: 'b', label: 'added one', delta: 'added' },
      { from: 'b', to: 'a', label: 'removed one', delta: 'removed' },
    ]
    const wires = levelWires(edges, wireEndpoints(ground.components))
    expect(wires.map((wire) => wire.delta)).toEqual(['kept', 'added', 'removed'])
    expect(wires.every((wire) => wire.path.startsWith('M '))).toBe(true)
  })

  it('drops a wire whose end is not on the ground rather than guessing a point', () => {
    const edges: CuratedEdge[] = [{ from: 'a', to: 'ghost', label: 'x', delta: 'kept' }]
    expect(levelWires(edges, wireEndpoints(ground.components))).toEqual([])
  })

  it('uses the After label when the edge carries one', () => {
    const edges: CuratedEdge[] = [
      { from: 'a', to: 'b', label: 'today', labelNext: 'after', delta: 'kept' },
      { from: 'a', to: 'b', label: 'only', delta: 'kept' },
    ]
    const wires = levelWires(edges, wireEndpoints(ground.components))
    expect(wires.map((wire) => wire.labelNext)).toEqual(['after', 'only'])
  })
})

describe('ladderLit', () => {
  const node = (id: string, phases?: number[]): CuratedNode => ({
    id,
    kind: 'module',
    title: id,
    delta: 'stable',
    ...(phases === undefined ? {} : { phases }),
  })
  const level: CuratedLevel = {
    title: 'F',
    nodes: [node('a', [1]), node('b', [2]), node('c')],
    edges: [],
  }

  it('lights everything when no rung is selected', () => {
    const { lit, dimming } = ladderLit(level, null)
    expect([...lit].sort()).toEqual(['a', 'b', 'c'])
    expect(dimming).toBe(false)
  })

  it('lights only what the rung touches, and dims the rest', () => {
    const { lit, dimming } = ladderLit(level, 1)
    expect([...lit]).toEqual(['a'])
    expect(dimming).toBe(true)
  })

  it('lights everything for a phase that touches nothing — never a blank sheet', () => {
    const { lit, dimming } = ladderLit(level, 9)
    expect([...lit].sort()).toEqual(['a', 'b', 'c'])
    expect(dimming).toBe(false)
  })
})

describe('changesStripFor', () => {
  it('keeps identity.children order exactly', () => {
    const chips = changesStripFor([
      { id: 'feature:c-one', name: 'One' },
      { id: 'feature:c-two', name: 'Two' },
      { id: 'feature:c-three', name: 'Three' },
    ])
    expect(chips.map((chip) => chip.name)).toEqual(['One', 'Two', 'Three'])
  })

  it('marks an id-less child as a label, never a dead control', () => {
    const chips = changesStripFor([{ id: '', name: 'Legacy' }])
    expect(chips[0].openable).toBe(false)
  })

  it('defaults the kind word and leaves an unknown date null', () => {
    const chips = changesStripFor([{ id: 'x', name: 'One' }])
    expect(chips[0].kind).toBe(DEFAULT_CHANGE_KIND)
    expect(chips[0].date).toBeNull()
  })

  it('takes kind and date from the meta the caller supplies', () => {
    const chips = changesStripFor(
      [{ id: 'x', name: 'One' }],
      new Map([['x', { kind: 'plan', date: '2026-08-27' }]]),
    )
    expect(chips[0]).toEqual({
      id: 'x',
      name: 'One',
      kind: 'plan',
      date: '2026-08-27',
      openable: true,
    })
  })

  it('drops a child with a blank name', () => {
    expect(changesStripFor([{ id: 'x', name: '   ' }])).toEqual([])
  })
})

describe('ghostPartNames', () => {
  const proposal = (label: string, kind: string): BriefNodeProposal => ({
    fingerprint: `${label}+${kind}`,
    label,
    change: 'new',
    state: 'proposed',
    kind,
    resolvedAnchors: [],
    source: { plan: 'p', doc: 'p', kind: 'plan' },
  })
  const node = (
    nodeId: string,
    kind: BriefDeltaNode['kind'],
    label: string,
    proposals: BriefNodeProposal[] = [],
  ): BriefDeltaNode => ({
    nodeId,
    kind,
    existsToday: kind !== 'new',
    label,
    ...(proposals.length === 0
      ? {}
      : { provenance: { source: 'proposal' as const, predicted: true, proposals } }),
  })
  const delta = (nodes: BriefDeltaNode[]): BriefDeltaInput => ({ nodes, wires: [], fails: [] })

  it('names nothing in Today — the plan has not happened there', () => {
    const input = delta([node('part:Streamer', 'new', 'Streamer')])
    expect(ghostPartNames(input, 'now').size).toBe(0)
  })

  it('names a part a live proposal predicts', () => {
    const input = delta([node('module:src/x', 'modify', 'x', [proposal('Streamer', 'part')])])
    expect([...ghostPartNames(input, 'next')]).toEqual(['Streamer'])
  })

  it('ignores a proposal that predicts something other than a part', () => {
    const input = delta([node('module:src/x', 'modify', 'x', [proposal('POST /x', 'endpoint')])])
    expect(ghostPartNames(input, 'next').size).toBe(0)
  })

  it('names a new delta node written in the part grammar', () => {
    const input = delta([node('part:Streamer', 'new', 'Streamer')])
    expect([...ghostPartNames(input, 'next')]).toEqual(['Streamer'])
  })

  it('never dashes a province on a coincidence — a new node that is not a part', () => {
    const input = delta([node('module:src/streamer', 'new', 'Streamer')])
    expect(ghostPartNames(input, 'next').size).toBe(0)
  })

  it('reads the proposal layer’s own nodes as well as the delta’s', () => {
    const input: BriefDeltaInput = {
      nodes: [],
      wires: [],
      fails: [],
      proposed: {
        nodes: [node('module:src/x', 'modify', 'x', [proposal('Store', 'part')])],
        sources: [],
        nothingProposed: false,
        summary: '',
        skipped: [],
      },
    }
    expect([...ghostPartNames(input, 'next')]).toEqual(['Store'])
  })
})

describe('delta vocabulary', () => {
  it('badges nothing in Today and one word per kind in After', () => {
    expect(deltaBadge('new', 'now')).toBeNull()
    expect(deltaBadge('stable', 'next')).toBeNull()
    expect(deltaBadge('new', 'next')).toBe('NEW')
    expect(deltaBadge('modify', 'next')).toBe('MODIFY')
    expect(deltaBadge('remove', 'next')).toBe('REMOVE')
  })

  it('strikes a removal only in After', () => {
    expect(struckIn('remove', 'now')).toBe(false)
    expect(struckIn('remove', 'next')).toBe(true)
    expect(struckIn('modify', 'next')).toBe(false)
  })
})

describe('isFileCardId', () => {
  it('recognises a part level’s file cards and nothing else', () => {
    expect(isFileCardId('file:src/a.ts')).toBe(true)
    expect(isFileCardId('part:Streamer')).toBe(false)
    expect(isFileCardId('module:src/a')).toBe(false)
  })
})
