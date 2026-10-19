import {
  cellLabelClass,
  coverageOf,
  inset,
  isRoomy,
  levelItems,
  moduleOfPath,
  squarify,
  strips,
  FLOOR_SHARE,
  LABEL_DOT_MIN,
  LABEL_NAME_MIN,
  LABEL_SHORT_MIN,
  ROOMY_MIN,
  TAIL_FOLD_RATIO,
  VALUE_FLOOR,
  type Placed,
  type Rect,
  CEILING_SHARE,
  capValues,
  focusLayout,
  layoutTree,
  squarifyFocused,
  squarifyPlan,
  FOCUS_MIN,
  FOCUS_SHARE,
  type SliceTree,
  ceilingShare,
  detailsFit,
  grownBy,
  restingFolderTier,
  DETAILS_TARGET,
} from './territory-layout'
import type { FeatureGraphInput, FeatureGraphNodeInput } from './feature-view-model'
import type { BlueprintLearningEntry } from '../../shared/ipc-contract'

interface Item {
  id: string
  value: number
}

const items = (...values: number[]): Item[] =>
  values.map((value, index) => ({ id: `i${index}`, value }))

const SHEET: Rect = { x: 0, y: 0, w: 400, h: 200 }

/** Total drawn area — must equal the rect's, or the sheet has a hole in it. */
const areaOf = (placed: readonly Placed<Item>[]): number =>
  placed.reduce((sum, cell) => sum + cell.w * cell.h, 0)

/** True when two rects share more than a shared edge. */
const overlaps = (a: Rect, b: Rect): boolean => {
  const EPS = 1e-9
  return (
    a.x + a.w - b.x > EPS && b.x + b.w - a.x > EPS && a.y + a.h - b.y > EPS && b.y + b.h - a.y > EPS
  )
}

/** How many strips the layout actually cut, read off the placed rects: a
 *  horizontal layout puts each strip at its own `y`, a vertical one at its own `x`. */
const stripCount = (placed: readonly Placed<Item>[], horizontal: boolean): number =>
  new Set(placed.map((cell) => (horizontal ? cell.y : cell.x).toFixed(6))).size

describe('strips — the ordered strip treemap (Phase 1)', () => {
  it('tiles the rect exactly: the drawn area IS the rect area', () => {
    const placed = strips(items(10, 7, 5, 3, 2, 1), SHEET)
    expect(areaOf(placed)).toBeCloseTo(SHEET.w * SHEET.h, 6)
  })

  it('keeps every cell inside the rect, honouring its offset', () => {
    const rect: Rect = { x: 20, y: 10, w: 300, h: 180 }
    const placed = strips(items(9, 6, 4, 4, 2, 1, 1), rect)
    const EPS = 1e-9
    for (const cell of placed) {
      expect(cell.w).toBeGreaterThan(0)
      expect(cell.h).toBeGreaterThan(0)
      expect(cell.x).toBeGreaterThanOrEqual(rect.x - EPS)
      expect(cell.y).toBeGreaterThanOrEqual(rect.y - EPS)
      expect(cell.x + cell.w).toBeLessThanOrEqual(rect.x + rect.w + EPS)
      expect(cell.y + cell.h).toBeLessThanOrEqual(rect.y + rect.h + EPS)
    }
  })

  it('never overlaps two cells', () => {
    const placed = strips(items(12, 9, 7, 5, 3, 2, 2, 1), SHEET)
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        expect(overlaps(placed[a], placed[b])).toBe(false)
      }
    }
  })

  /*
   * The whole reason strips beat squarified packing: a cell moves only when the
   * STORE moves. An output that reordered would make position mean nothing,
   * which is the ring's bug in a new shape.
   */
  it('preserves input order', () => {
    const placed = strips(items(1, 40, 3, 20, 5), SHEET)
    expect(placed.map((cell) => cell.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
  })

  it('carries the item through untouched beside its rect', () => {
    const [cell] = strips([{ id: 'chats', value: 12 }], SHEET)
    expect(cell).toEqual({ id: 'chats', value: 12, x: 0, y: 0, w: 400, h: 200 })
  })

  it('folds a sliver tail strip into the one before it', () => {
    // Same five-item shape, only the tail differs: a full-size tail keeps its
    // own strip, a sliver one is folded and the layout has one strip fewer.
    const kept = strips(items(10, 10, 10, 10, 10), SHEET)
    const folded = strips(items(10, 10, 10, 10, 1), SHEET)
    expect(stripCount(kept, true)).toBe(2)
    expect(stripCount(folded, true)).toBe(1)
    // Folding must not lose the item or the area it was owed.
    expect(folded.map((cell) => cell.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
    expect(areaOf(folded)).toBeCloseTo(SHEET.w * SHEET.h, 6)
  })

  it('leaves a tail strip alone when it is at least TAIL_FOLD_RATIO of its predecessor', () => {
    expect(TAIL_FOLD_RATIO).toBe(0.45)
    const placed = strips(items(20, 10, 8, 6, 1), SHEET)
    expect(stripCount(placed, true)).toBe(2)
  })

  it('is deterministic — same input, deep-equal output', () => {
    const input = items(7, 5, 5, 3, 2, 1)
    expect(strips(input, SHEET)).toEqual(strips(input, SHEET))
  })

  it('gives a single item the whole rect', () => {
    expect(strips(items(3), SHEET)).toEqual([{ id: 'i0', value: 3, ...SHEET }])
  })

  it('returns nothing for no items', () => {
    expect(strips([], SHEET)).toEqual([])
  })

  it('returns nothing for a degenerate rect rather than a negative cell', () => {
    expect(strips(items(1, 2), { x: 0, y: 0, w: 0, h: 200 })).toEqual([])
    expect(strips(items(1, 2), { x: 0, y: 0, w: 400, h: -5 })).toEqual([])
  })

  /*
   * A feature that claims no code still exists. Zero area would draw a sheet
   * that says otherwise — the floor is what keeps the omission from being a lie.
   */
  it('floors zero values so a zero-anchor item still draws', () => {
    expect(VALUE_FLOOR).toBe(0.4)
    const placed = strips(items(0, 0), SHEET)
    expect(placed).toHaveLength(2)
    for (const cell of placed) {
      expect(cell.w).toBeGreaterThan(0)
      expect(cell.h).toBeGreaterThan(0)
    }
    // All floored equally → equal cells.
    expect(placed[0].w).toBeCloseTo(placed[1].w, 9)
    expect(placed[0].h).toBeCloseTo(placed[1].h, 9)
  })

  it('gives a zero its floor beside a real value, never nothing', () => {
    const [big, nothing] = strips(items(10, 0), SHEET)
    expect(nothing.w * nothing.h).toBeGreaterThan(0)
    expect(big.w * big.h).toBeGreaterThan(nothing.w * nothing.h)
    expect(areaOf([big, nothing])).toBeCloseTo(SHEET.w * SHEET.h, 6)
  })

  it('cuts columns, not rows, when the rect is taller than it is wide', () => {
    const tall: Rect = { x: 0, y: 0, w: 200, h: 400 }
    const placed = strips(items(10, 10, 10, 10, 10), tall)
    expect(stripCount(placed, false)).toBe(2)
    expect(areaOf(placed)).toBeCloseTo(tall.w * tall.h, 6)
  })
})

describe('inset — the one place a gap is taken (Phase 1)', () => {
  it('shrinks by d on every side', () => {
    expect(inset({ x: 10, y: 20, w: 100, h: 50 }, 4)).toEqual({ x: 14, y: 24, w: 92, h: 42 })
  })

  it('collapses to a point rather than going negative', () => {
    expect(inset({ x: 0, y: 0, w: 5, h: 5 }, 4)).toEqual({ x: 4, y: 4, w: 0, h: 0 })
  })

  it('is a no-op at zero', () => {
    const rect: Rect = { x: 1, y: 2, w: 3, h: 4 }
    expect(inset(rect, 0)).toEqual(rect)
  })
})

describe('cellLabelClass / isRoomy — names degrade by size (Phase 1)', () => {
  it('prints the full name exactly at the name minimum', () => {
    expect(cellLabelClass(LABEL_NAME_MIN.w, LABEL_NAME_MIN.h)).toBe('')
  })

  it('drops to the short name one pixel under either dimension', () => {
    expect(cellLabelClass(LABEL_NAME_MIN.w - 1, LABEL_NAME_MIN.h)).toBe('tiny')
    expect(cellLabelClass(LABEL_NAME_MIN.w, LABEL_NAME_MIN.h - 1)).toBe('tiny')
  })

  it('prints the short name exactly at the short minimum', () => {
    expect(cellLabelClass(LABEL_SHORT_MIN.w, LABEL_SHORT_MIN.h)).toBe('tiny')
  })

  it('drops to the dot one pixel under either short dimension', () => {
    expect(cellLabelClass(LABEL_SHORT_MIN.w - 1, LABEL_SHORT_MIN.h)).toBe('dot')
    expect(cellLabelClass(LABEL_SHORT_MIN.w, LABEL_SHORT_MIN.h - 1)).toBe('dot')
  })

  it('prints the dot exactly at the dot minimum', () => {
    expect(cellLabelClass(LABEL_DOT_MIN.w, LABEL_DOT_MIN.h)).toBe('dot')
  })

  it('goes blank one pixel under either dot dimension', () => {
    expect(cellLabelClass(LABEL_DOT_MIN.w - 1, LABEL_DOT_MIN.h)).toBe('blank')
    expect(cellLabelClass(LABEL_DOT_MIN.w, LABEL_DOT_MIN.h - 1)).toBe('blank')
  })

  /*
   * BOTH dimensions gate every tier. A wide ribbon has all the width in the
   * world and nowhere to put a line of text; width alone would print a name
   * into four pixels of height.
   */
  it('blanks a wide, flat ribbon however much width it has', () => {
    expect(cellLabelClass(400, LABEL_DOT_MIN.h - 1)).toBe('blank')
    expect(cellLabelClass(LABEL_DOT_MIN.w - 1, 400)).toBe('blank')
  })

  it('is roomy exactly at the roomy minimum and not one pixel under', () => {
    expect(isRoomy(ROOMY_MIN.w, ROOMY_MIN.h)).toBe(true)
    expect(isRoomy(ROOMY_MIN.w - 1, ROOMY_MIN.h)).toBe(false)
    expect(isRoomy(ROOMY_MIN.w, ROOMY_MIN.h - 1)).toBe(false)
  })

  /* Roomy is a SEPARATE question from the label tier: a cell can print its full
   * name long before it has room for a second line under it. */
  it('is not roomy at the name minimum — the second line needs more', () => {
    expect(cellLabelClass(LABEL_NAME_MIN.w, LABEL_NAME_MIN.h)).toBe('')
    expect(isRoomy(LABEL_NAME_MIN.w, LABEL_NAME_MIN.h)).toBe(false)
  })
})

const node = (over: Partial<FeatureGraphNodeInput> & Pick<FeatureGraphNodeInput, 'id' | 'kind'>): FeatureGraphNodeInput => ({
  slug: over.id,
  name: over.id,
  understanding: 'none',
  active: false,
  anchorCount: 0,
  ...over,
})

describe('levelItems — what a level draws, by explicit kind (Phase 1)', () => {
  const graph: FeatureGraphInput = {
    nodes: [
      node({ id: 'chats', kind: 'core', name: 'Chats' }),
      node({ id: 'board', kind: 'core', name: 'Board' }),
      node({ id: 'chats/stream', kind: 'part', name: 'Stream', parent: 'chats' }),
      node({ id: 'chats/list', kind: 'part', name: 'List', parent: 'chats' }),
      node({ id: 'chats/migration', kind: 'child', name: 'Chat Session Cache Rework', parent: 'chats' }),
    ],
    edges: [],
  }

  it('opens on the core features when nothing carries a domain', () => {
    const level = levelItems(graph, null)
    expect(level.map((item) => item.id)).toEqual(['chats', 'board'])
    expect(level.every((item) => item.kind === 'feature')).toBe(true)
  })

  it('opens on the domains as soon as any core carries one', () => {
    const domained: FeatureGraphInput = {
      nodes: [
        node({ id: 'chats', kind: 'core', name: 'Chats', domain: 'Conversation' }),
        node({ id: 'board', kind: 'core', name: 'Board' }),
      ],
      edges: [],
    }
    const level = levelItems(domained, null)
    expect(level.every((item) => item.kind === 'domain')).toBe(true)
    expect(level.map((item) => item.name)).toEqual(['Conversation', 'Unassigned'])
  })

  it("draws a domain's features when a domain is the focus", () => {
    const domained: FeatureGraphInput = {
      nodes: [
        node({ id: 'chats', kind: 'core', name: 'Chats', domain: 'Conversation' }),
        node({ id: 'threads', kind: 'core', name: 'Threads', domain: 'Conversation' }),
        node({ id: 'board', kind: 'core', name: 'Board', domain: 'Map' }),
      ],
      edges: [],
    }
    const [conversation] = levelItems(domained, null)
    expect(levelItems(domained, conversation).map((item) => item.name)).toEqual([
      'Chats',
      'Threads',
    ])
  })

  /*
   * A CHANGE IS NEVER A CELL. Drilling Chats used to show two plan names under
   * the kicker "2 parts" while its real parts were nowhere — that collapse is
   * what this asserts has not come back at any depth.
   */
  it("draws a feature's PARTS and never a change record", () => {
    const [chats] = levelItems(graph, null)
    const level = levelItems(graph, chats)
    expect(level.map((item) => item.name)).toEqual(['Stream', 'List'])
    expect(level.every((item) => item.kind === 'part')).toBe(true)
    expect(level.some((item) => item.name === 'Chat Session Cache Rework')).toBe(false)
  })

  it('never returns a change record at the root either', () => {
    const level = levelItems(graph, null)
    expect(level.some((item) => item.kind === 'change')).toBe(false)
  })

  it('counts parts without subtracting the change from a total', () => {
    const [chats] = levelItems(graph, null)
    expect(chats.childCount).toBe(2)
    expect(chats.kicker).toBe('2 parts')
  })

  it('draws nothing below a part — a part is a leaf', () => {
    const [chats] = levelItems(graph, null)
    const [stream] = levelItems(graph, chats)
    expect(levelItems(graph, stream)).toEqual([])
  })

  it('returns nothing for an empty graph rather than inventing a level', () => {
    expect(levelItems({ nodes: [], edges: [] }, null)).toEqual([])
  })
})

describe('moduleOfPath — the module a reference names (Phase 1)', () => {
  it('reads a `module:` ref as its own path', () => {
    expect(moduleOfPath('module:src/lib')).toBe('src/lib')
  })

  it("reads a `file:` ref as the file's directory", () => {
    expect(moduleOfPath('file:src/lib/thing.ts')).toBe('src/lib')
  })

  it('strips a `file:` locator suffix before taking the directory', () => {
    expect(moduleOfPath('file:src/lib/thing.ts:doThing')).toBe('src/lib')
  })

  it("reads a bare file path as the file's directory", () => {
    expect(moduleOfPath('src/lib/thing.ts')).toBe('src/lib')
  })

  /* The trailing-extension rule is the whole of the bare-ref distinction: no
   * extension on the last segment means the ref was already a directory. */
  it('reads a bare directory as itself', () => {
    expect(moduleOfPath('src/lib')).toBe('src/lib')
    expect(moduleOfPath('src/lib/sub-dir')).toBe('src/lib/sub-dir')
  })

  it('has no module for a file at the repo root', () => {
    expect(moduleOfPath('thing.ts')).toBeNull()
    expect(moduleOfPath('file:thing.ts')).toBeNull()
  })

  it('has no module for an empty or blank ref', () => {
    expect(moduleOfPath('')).toBeNull()
    expect(moduleOfPath('   ')).toBeNull()
  })

  it('has no module for a ref kind that names no path', () => {
    expect(moduleOfPath('endpoint:GET /things')).toBeNull()
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(moduleOfPath('  src/lib/thing.ts  ')).toBe('src/lib')
  })
})

const learned = (module: string): BlueprintLearningEntry => ({
  module,
  status: 'learned',
  notedAt: '2026-08-27T00:00:00.000Z',
})

describe('coverageOf — the Learning lens fraction (Phase 1)', () => {
  it('is 0 when nothing on the ground has been learned', () => {
    expect(coverageOf(['src/a', 'src/b'], [])).toBe(0)
  })

  it('is 1 when every countable module is learned', () => {
    expect(coverageOf(['src/a', 'src/b'], [learned('src/a'), learned('src/b')])).toBe(1)
  })

  it('is the fraction learned in between', () => {
    expect(coverageOf(['src/a', 'src/b'], [learned('src/a')])).toBeCloseTo(0.5, 9)
  })

  it('is 0 for an empty module set — 0/0 is never drawn as full', () => {
    expect(coverageOf([], [learned('src/a')])).toBe(0)
  })

  it('matches a `module:` graph id against a bare learning entry', () => {
    expect(coverageOf(['module:src/a'], [learned('src/a')])).toBe(1)
    expect(coverageOf(['src/a'], [{ ...learned('module:src/a') }])).toBe(1)
  })

  it('counts a module once however many times it is named', () => {
    expect(coverageOf(['src/a', 'src/a', 'module:src/a'], [learned('src/a')])).toBe(1)
  })

  /*
   * ONLY `learned` COUNTS. Stale knowledge is knowledge the code has moved past
   * and in-flight work is work not yet done — drawing either as coverage says
   * the ground is understood when it is not.
   */
  it('does not count stale, learning or queued as coverage', () => {
    const entries: BlueprintLearningEntry[] = [
      { module: 'src/a', status: 'stale', notedAt: '2026-08-27T00:00:00.000Z' },
      { module: 'src/b', status: 'learning', notedAt: '2026-08-27T00:00:00.000Z' },
      { module: 'src/c', status: 'queued', notedAt: '2026-08-27T00:00:00.000Z' },
    ]
    expect(coverageOf(['src/a', 'src/b', 'src/c'], entries)).toBe(0)
  })

  /*
   * An ignored module leaves BOTH sides of the fraction. Counting it in the
   * denominator only would draw a line that can never reach full on a feature
   * whose every real module is learned.
   */
  it('removes a default-ignored module from numerator AND denominator', () => {
    expect(coverageOf(['src/a', 'src/__tests__'], [learned('src/a')])).toBe(1)
    expect(coverageOf(['src/a', 'e2e/checkout'], [learned('src/a')])).toBe(1)
    expect(coverageOf(['src/a', '.github/workflows'], [learned('src/a')])).toBe(1)
  })

  it('does not let an ignored-but-learned module inflate the fraction', () => {
    expect(coverageOf(['src/a', 'src/__tests__'], [learned('src/__tests__')])).toBe(0)
  })

  it('honours the configured extra ignore patterns', () => {
    expect(coverageOf(['src/a', 'vendor/sdk'], [learned('src/a')], ['vendor'])).toBe(1)
    expect(coverageOf(['src/a', 'vendor/sdk'], [learned('src/a')])).toBeCloseTo(0.5, 9)
  })

  it('is 0 when every module in the set is ignored', () => {
    expect(coverageOf(['src/__tests__', 'e2e/checkout'], [learned('src/__tests__')])).toBe(0)
  })

  it('ignores blank entries in the module set', () => {
    expect(coverageOf(['src/a', '', '   '], [learned('src/a')])).toBe(1)
  })
})

describe('squarify — the size-sorted squarified treemap (2026-08-28)', () => {
  const skewed = items(6000, 200, 800, 0, 50, 3000)

  it('tiles the rect exactly: the drawn area IS the rect area', () => {
    expect(areaOf(squarify(skewed, SHEET))).toBeCloseTo(SHEET.w * SHEET.h, 6)
  })

  it('never overlaps two cells and keeps every cell inside the rect', () => {
    const placed = squarify(skewed, { x: 30, y: 40, w: 400, h: 200 })
    for (const cell of placed) {
      expect(cell.x).toBeGreaterThanOrEqual(30 - 1e-9)
      expect(cell.y).toBeGreaterThanOrEqual(40 - 1e-9)
      expect(cell.x + cell.w).toBeLessThanOrEqual(430 + 1e-6)
      expect(cell.y + cell.h).toBeLessThanOrEqual(240 + 1e-6)
    }
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) expect(overlaps(placed[i], placed[j])).toBe(false)
    }
  })

  it('places items largest first, so the biggest is the top-left cell', () => {
    const placed = squarify(skewed, SHEET)
    expect(placed[0].id).toBe('i0')
    expect(placed[1].id).toBe('i5')
    expect(placed[0].x).toBe(0)
    expect(placed[0].y).toBe(0)
    for (let i = 1; i < placed.length; i += 1) {
      expect(placed[i - 1].w * placed[i - 1].h).toBeGreaterThanOrEqual(placed[i].w * placed[i].h - 1e-6)
    }
  })

  it('gives area in proportion to value', () => {
    const placed = squarify(items(3000, 1000), SHEET)
    const big = placed.find((cell) => cell.id === 'i0')!
    const small = placed.find((cell) => cell.id === 'i1')!
    expect((big.w * big.h) / (small.w * small.h)).toBeCloseTo(3, 6)
  })

  it('raises a zero to FLOOR_SHARE of the total so it still draws', () => {
    const placed = squarify(items(1000, 0), SHEET)
    const zero = placed.find((cell) => cell.id === 'i1')!
    const total = 1000 + 1000 * FLOOR_SHARE
    expect((zero.w * zero.h) / (SHEET.w * SHEET.h)).toBeCloseTo((1000 * FLOOR_SHARE) / total, 6)
  })

  it('keeps cells nearer square than the ordered strips on the same skewed set', () => {
    const worst = (placed: readonly Placed<Item>[]): number =>
      Math.max(...placed.map((cell) => Math.max(cell.w / cell.h, cell.h / cell.w)))
    expect(worst(squarify(skewed, SHEET))).toBeLessThanOrEqual(worst(strips(skewed, SHEET)) + 1e-9)
  })

  it('is deterministic and keeps ties in input order', () => {
    expect(squarify(skewed, SHEET)).toEqual(squarify(skewed, SHEET))
    const tied = squarify(items(5, 5, 5), SHEET)
    expect(tied.map((cell) => cell.id)).toEqual(['i0', 'i1', 'i2'])
  })

  it('gives a single item the whole rect and nothing for no items or a degenerate rect', () => {
    expect(squarify(items(7), SHEET)).toEqual([{ id: 'i0', value: 7, ...SHEET }])
    expect(squarify([], SHEET)).toEqual([])
    expect(squarify(items(1, 2), { x: 0, y: 0, w: 0, h: 100 })).toEqual([])
  })
})

describe('the ceiling — no item fills the sheet alone (2026-10-06)', () => {
  it('caps the largest at the share, of the CAPPED total, and keeps the rest in proportion', () => {
    const capped = capValues([9000, 100, 100, 100, 100, 100, 100, 100, 100], CEILING_SHARE)
    const total = capped.reduce((sum, value) => sum + value, 0)
    expect((capped[0] ?? 0) / total).toBeCloseTo(CEILING_SHARE, 9)
    expect(capped.slice(1)).toEqual(Array(8).fill(100))
  })

  it('leaves values that already fit untouched, and can cap more than one', () => {
    expect(capValues([30, 30, 20, 20], CEILING_SHARE)).toEqual([30, 30, 20, 20])
    const two = capValues([1000, 1000, 10, 10, 10, 10], CEILING_SHARE)
    const total = two.reduce((sum, value) => sum + value, 0)
    expect((two[0] ?? 0) / total).toBeCloseTo(CEILING_SHARE, 9)
    expect((two[1] ?? 0) / total).toBeCloseTo(CEILING_SHARE, 9)
  })

  it('applies from four items up — a few items are drawn as they are', () => {
    expect(ceilingShare(2)).toBe(1)
    expect(ceilingShare(3)).toBe(1)
    expect(ceilingShare(9)).toBe(CEILING_SHARE)
    const items = [{ id: 'big', value: 9000 }, ...Array.from({ length: 8 }, (_, i) => ({ id: `p${String(i)}`, value: 100 }))]
    const placed = squarify(items, SHEET)
    const big = placed.find((cell) => cell.id === 'big')!
    expect((big.w * big.h) / (SHEET.w * SHEET.h)).toBeCloseTo(CEILING_SHARE, 6)
  })
})

describe('focusLayout — a hovered cell grows in place (plan cell-hover-diagram, in-place grow)', () => {
  const STAGE: Rect = { x: 6, y: 8, w: 1018, h: 480 }
  const LEVEL = items(2600, 1400, 900, 700, 420, 300, 180, 120, 80)
  const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  const contains = (outer: Rect, point: { x: number; y: number }): boolean =>
    point.x >= outer.x - 1e-6 && point.x <= outer.x + outer.w + 1e-6 && point.y >= outer.y - 1e-6 && point.y <= outer.y + outer.h + 1e-6
  const byId = (placed: readonly Placed<Item>[]): Map<string, Placed<Item>> => new Map(placed.map((cell) => [cell.id, cell]))
  const area = (r: Rect): number => r.w * r.h

  it('with no focus IS squarify — same cells, same order, same rects', () => {
    expect(squarifyFocused(LEVEL, STAGE, -1)).toEqual(squarify(LEVEL, STAGE))
  })

  it('the plan reproduces squarify exactly, cut by cut', () => {
    const plan = squarifyPlan(LEVEL.map((item) => item.value), STAGE)
    const rects = layoutTree(plan.tree as SliceTree, STAGE, plan.weights)
    const plain = byId(squarify(LEVEL, STAGE))
    LEVEL.forEach((item, index) => {
      const want = plain.get(item.id) as Placed<Item>
      const got = rects[index] as Rect
      expect(got.x).toBeCloseTo(want.x, 9)
      expect(got.y).toBeCloseTo(want.y, 9)
      expect(got.w).toBeCloseTo(want.w, 9)
      expect(got.h).toBeCloseTo(want.h, 9)
    })
  })

  // FIRST, MIDDLE, LAST, AND THE CORNERS of the drawn order.
  const positions = [0, 1, 3, 4, 6, 8]
  it.each(positions)('drawn position %i: grows to the share, keeps its old centre, order unchanged', (position) => {
    const plain = squarify(LEVEL, STAGE)
    const target = plain[position] as Placed<Item>
    const focus = LEVEL.findIndex((item) => item.id === target.id)
    const grown = squarifyFocused(LEVEL, STAGE, focus)
    // ORDER IS PRESERVED: the drawn order is the plain one.
    expect(grown.map((cell) => cell.id)).toEqual(plain.map((cell) => cell.id))
    const cell = byId(grown).get(target.id) as Placed<Item>
    expect(area(cell) / area(STAGE)).toBeGreaterThanOrEqual(FOCUS_SHARE - 1e-3)
    // IT GREW WHERE IT WAS: the old rectangle — and so its centre — is inside the new one.
    expect(contains(cell, centre(target))).toBe(true)
    expect(contains(cell, { x: target.x, y: target.y })).toBe(true)
    expect(contains(cell, { x: target.x + target.w, y: target.y + target.h })).toBe(true)
    // Every other cell got smaller — or is held at its floor in one dimension
    // (a column at the minimum width keeps the column's height) — and none is
    // under the floor.
    for (const other of grown) {
      if (other.id === target.id) continue
      const before = byId(plain).get(other.id) as Placed<Item>
      const atFloor = Math.abs(other.w - FOCUS_MIN.w) < 1e-6 || Math.abs(other.h - FOCUS_MIN.h) < 1e-6
      expect(atFloor || area(other) <= area(before) + 1e-6).toBe(true)
      expect(other.w).toBeGreaterThanOrEqual(FOCUS_MIN.w - 1e-6)
      expect(other.h).toBeGreaterThanOrEqual(FOCUS_MIN.h - 1e-6)
    }
    // Still a treemap: the pieces tile the stage.
    expect(areaOf(grown)).toBeCloseTo(area(STAGE), 3)
  })

  it('others keep their sizes relative to each other where no floor binds', () => {
    const level = items(500, 400, 300, 200)
    const grown = byId(squarifyFocused(level, STAGE, 3))
    const a = area(grown.get('i0') as Rect)
    const b = area(grown.get('i1') as Rect)
    expect(a / b).toBeCloseTo(500 / 400, 1)
  })

  it('a cell already bigger than the share keeps its own size', () => {
    const level = items(9000, 100, 100)
    const plain = byId(squarify(level, STAGE))
    const grown = byId(squarifyFocused(level, STAGE, 0))
    // Its neighbours are held at their floor, so it gives a little to them — never below the share.
    expect(area(grown.get('i0') as Rect) / area(STAGE)).toBeGreaterThanOrEqual(FOCUS_SHARE - 1e-3)
    expect(area(grown.get('i0') as Rect)).toBeGreaterThan(0.9 * area(plain.get('i0') as Rect))
  })

  it('a single cell is the whole level, focused or not', () => {
    expect(squarifyFocused(items(5), STAGE, 0)).toEqual([{ id: 'i0', value: 5, ...STAGE }])
  })

  it('two cells: the focused one takes the share, beside its sibling in the same order', () => {
    const level = items(300, 700)
    const plain = squarify(level, STAGE)
    const grown = squarifyFocused(level, STAGE, 0)
    expect(grown.map((cell) => cell.id)).toEqual(plain.map((cell) => cell.id))
    const cell = byId(grown).get('i0') as Placed<Item>
    expect(area(cell) / area(STAGE)).toBeCloseTo(FOCUS_SHARE, 6)
    expect(contains(cell, centre(byId(plain).get('i0') as Rect))).toBe(true)
  })

  it('floors share what there is when the level has more cells than room', () => {
    const crowded = items(...Array.from({ length: 60 }, (_, i) => 60 - i))
    const grown = squarifyFocused(crowded, { x: 0, y: 0, w: 400, h: 200 }, 10)
    expect(grown).toHaveLength(60)
    for (const cell of grown) {
      expect(cell.w).toBeGreaterThan(0)
      expect(cell.h).toBeGreaterThan(0)
    }
    expect(areaOf(grown)).toBeCloseTo(400 * 200, 3)
  })

  it('in a bigger rect (a country that grew), the cell still contains where it was', () => {
    const before: Rect = { x: 100, y: 50, w: 300, h: 200 }
    const after: Rect = { x: 40, y: 20, w: 700, h: 420 }
    const level = items(50, 40, 30, 20, 10)
    const plain = squarify(level, before)
    for (const target of plain) {
      const focus = level.findIndex((item) => item.id === target.id)
      const grown = byId(squarifyFocused(level, after, focus, { from: before })).get(target.id) as Rect
      expect(contains(grown, centre(target))).toBe(true)
    }
  })

  it('focusLayout on a hand-made tree honours the share and never moves a cut past the old edge', () => {
    const tree: SliceTree = { axis: 'x', children: [{ leaf: 0 }, { axis: 'y', children: [{ leaf: 1 }, { leaf: 2 }] }] }
    const rect: Rect = { x: 0, y: 0, w: 600, h: 300 }
    const weights = [1, 1, 1]
    const plain = layoutTree(tree, rect, weights)
    const grown = focusLayout(tree, weights, rect, 2)
    expect(area(grown[2] as Rect) / area(rect)).toBeGreaterThanOrEqual(FOCUS_SHARE - 1e-3)
    expect(contains(grown[2] as Rect, centre(plain[2] as Rect))).toBe(true)
    expect((grown[0] as Rect).x).toBe(0)
  })

  it('an opened cell is big in both directions even when its column has many neighbours (2026-10-08)', () => {
    // Twelve columns side by side, the focus in the first: at a 64px floor each
    // the eleven others take ~700px of an 820px row, leaving the opened cell a
    // thin strip. Their floors give way so it gets at least half the width.
    const tree: SliceTree = { axis: 'x', children: Array.from({ length: 12 }, (_, leaf) => ({ leaf })) }
    const rect: Rect = { x: 0, y: 0, w: 820, h: 1100 }
    const weights = Array.from({ length: 12 }, () => 1)
    const grown = focusLayout(tree, weights, rect, 0)
    const opened = grown[0] as Rect
    expect(opened.w).toBeGreaterThanOrEqual(rect.w * 0.5)
    expect(opened.h).toBeGreaterThanOrEqual(rect.h * 0.5)
    // Everyone else still has a rectangle, small but drawn, and nothing overlaps the opened cell.
    for (const other of grown.slice(1)) {
      expect((other as Rect).w).toBeGreaterThan(0)
      expect((other as Rect).x).toBeGreaterThanOrEqual(opened.x + opened.w - 1e-6)
    }
  })

  it('does not mutate its inputs', () => {
    const level = items(5, 4, 3)
    const copy = JSON.parse(JSON.stringify(level)) as Item[]
    squarifyFocused(level, STAGE, 1)
    expect(level).toEqual(copy)
  })
})

describe('details on hover — the same in-place grow, only as big as the details need (2026-10-08)', () => {
  const STAGE: Rect = { x: 6, y: 8, w: 1018, h: 480 }
  const LEVEL = items(2600, 1400, 900, 700, 420, 300, 180, 120, 80)

  it('detailsFit: the target area over the level, the target as a share of each side', () => {
    const fit = detailsFit({ w: 1000, h: 500 }, { w: 100, h: 60 })
    expect(fit.share).toBeCloseTo((320 * 230) / (1000 * 500), 9)
    expect(fit.minSide.w).toBeCloseTo(0.32, 9)
    expect(fit.minSide.h).toBeCloseTo(0.46, 9)
  })

  it('detailsFit: never smaller than the cell already is, clamped to the level, capped by maxShare', () => {
    const big = detailsFit({ w: 1000, h: 500 }, { w: 500, h: 300 })
    expect(big.minSide).toEqual({ w: 0.5, h: 0.6 })
    expect(big.share).toBeCloseTo(0.3, 9)
    const cramped = detailsFit({ w: 300, h: 200 }, { w: 40, h: 30 })
    expect(cramped.minSide).toEqual({ w: 1, h: 1 })
    expect(cramped.share).toBe(FOCUS_SHARE)
    expect(detailsFit({ w: 0, h: 500 }, { w: 1, h: 1 })).toEqual({ share: 0, minSide: { w: 0, h: 0 } })
    expect(grownBy(DETAILS_TARGET, { w: 4, h: 2 })).toEqual({ w: 324, h: 232 })
  })

  it('a small cell grows to reach its target width AND height, and no further than an opened one', () => {
    const plain = squarify(LEVEL, STAGE)
    for (const target of plain) {
      if (target.w >= DETAILS_TARGET.w && target.h >= DETAILS_TARGET.h) continue
      const focus = LEVEL.findIndex((item) => item.id === target.id)
      const fit = detailsFit(STAGE, target)
      const grown = squarifyFocused(LEVEL, STAGE, focus, { share: fit.share, minSide: fit.minSide, maxShare: FOCUS_SHARE })
      const cell = grown.find((entry) => entry.id === target.id) as Placed<Item>
      expect(cell.w).toBeGreaterThanOrEqual(DETAILS_TARGET.w - 0.5)
      expect(cell.h).toBeGreaterThanOrEqual(DETAILS_TARGET.h - 0.5)
      const opened = squarifyFocused(LEVEL, STAGE, focus).find((entry) => entry.id === target.id) as Placed<Item>
      expect(cell.w * cell.h).toBeLessThan(opened.w * opened.h)
      // The others moved around it: inside the level, never on top of it.
      for (const other of grown) {
        if (other.id === target.id) continue
        expect(overlaps(other, cell)).toBe(false)
        expect(other.x).toBeGreaterThanOrEqual(STAGE.x - 1e-6)
        expect(other.y).toBeGreaterThanOrEqual(STAGE.y - 1e-6)
        expect(other.x + other.w).toBeLessThanOrEqual(STAGE.x + STAGE.w + 1e-6)
        expect(other.y + other.h).toBeLessThanOrEqual(STAGE.y + STAGE.h + 1e-6)
      }
      // Still where it was: the plain rectangle's centre is inside the grown one.
      const cx = target.x + target.w / 2
      const cy = target.y + target.h / 2
      expect(cx >= cell.x - 1e-6 && cx <= cell.x + cell.w + 1e-6 && cy >= cell.y - 1e-6 && cy <= cell.y + cell.h + 1e-6).toBe(true)
    }
  })

  it('a share met by a thin strip is raised until both sides are met', () => {
    // One row of twelve columns: the bare share would give the focus a column
    // 1100 tall and ~110 wide; the details need 320 of the width.
    const tree: SliceTree = { axis: 'x', children: Array.from({ length: 12 }, (_, leaf) => ({ leaf })) }
    const rect: Rect = { x: 0, y: 0, w: 1200, h: 400 }
    const weights = Array.from({ length: 12 }, () => 1)
    const fit = detailsFit(rect, { w: 100, h: 400 })
    const grown = focusLayout(tree, weights, rect, 3, { share: fit.share, minSide: fit.minSide })
    expect((grown[3] as Rect).w).toBeGreaterThanOrEqual(320 - 0.5)
  })

  it('without minSide the opened layout is unchanged (same as the default call)', () => {
    const plan = squarifyPlan(LEVEL.map((item) => item.value), STAGE)
    const tree = plan.tree as SliceTree
    expect(focusLayout(tree, plan.weights, STAGE, 4, {})).toEqual(focusLayout(tree, plan.weights, STAGE, 4))
  })
})

describe('restingFolderTier — calm at rest (2026-10-08)', () => {
  it('one home line at the roomy tier, whatever the size above it; nothing below', () => {
    expect(restingFolderTier(1000, 500)).toBe('line')
    expect(restingFolderTier(ROOMY_MIN.w, ROOMY_MIN.h)).toBe('line')
    expect(restingFolderTier(ROOMY_MIN.w - 1, 500)).toBeNull()
    expect(restingFolderTier(500, ROOMY_MIN.h - 1)).toBeNull()
  })
})
