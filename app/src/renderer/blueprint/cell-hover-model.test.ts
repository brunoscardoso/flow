import {
  DIAGRAM_LEGIBLE_SCALE,
  HOVER_CLOSE_GRACE_MS,
  HOVER_GROW_DELAY_MS,
  HOVER_IDLE,
  chooseDiagramLayout,
  fitScale,
  grownCellId,
  grownContent,
  hoverDeadline,
  hoverReduce,
  isLayoutEcho,
  siblingDiagramRoot,
  type HoverEvent,
  type HoverState,
} from './cell-hover-model'

describe('chooseDiagramLayout', () => {
  it('prefers the landscape layout that fills the cell over a tall column that never shrank', () => {
    // The part slice, measured live: one column 360 x 648 at 0.9, or two columns 832 x 452 at 0.79.
    const column = { content: { width: 360, height: 648 }, scale: 0.9 }
    const landscape = { content: { width: 832, height: 452 }, scale: 0.79 }
    expect(chooseDiagramLayout([column, landscape])).toBe(1)
  })

  it('never picks an unreadable layout while a readable one exists', () => {
    const readable = { content: { width: 400, height: 400 }, scale: 0.7 }
    const huge = { content: { width: 3000, height: 3000 }, scale: DIAGRAM_LEGIBLE_SCALE - 0.01 }
    expect(chooseDiagramLayout([readable, huge])).toBe(0)
  })

  it('falls back to the best of the unreadable ones when none is readable', () => {
    const small = { content: { width: 1000, height: 1000 }, scale: 0.3 }
    const bigger = { content: { width: 1000, height: 1000 }, scale: 0.4 }
    expect(chooseDiagramLayout([small, bigger])).toBe(1)
  })

  it('breaks an equal fill by the larger scale, then by the earlier candidate', () => {
    const a = { content: { width: 200, height: 100 }, scale: 1 }
    const b = { content: { width: 400, height: 200 }, scale: 0.5 }
    expect(chooseDiagramLayout([b, a])).toBe(1)
    expect(chooseDiagramLayout([a, { ...a }])).toBe(0)
  })

  it('answers -1 for no candidates', () => {
    expect(chooseDiagramLayout([])).toBe(-1)
  })
})

describe('fitScale', () => {
  it('shrinks to the tighter side and never enlarges', () => {
    expect(fitScale({ width: 800, height: 400 }, { width: 400, height: 400 })).toBeCloseTo(0.5, 9)
    expect(fitScale({ width: 400, height: 800 }, { width: 400, height: 400 })).toBeCloseTo(0.5, 9)
    expect(fitScale({ width: 100, height: 100 }, { width: 400, height: 400 })).toBe(1)
    expect(fitScale({ width: 0, height: 0 }, { width: 400, height: 400 })).toBe(1)
    expect(fitScale({ width: 100, height: 100 }, { width: -5, height: 400 })).toBe(0)
  })
})

describe('grownContent', () => {
  it('covers every branch', () => {
    expect(grownContent({ remote: true, loading: true, hasDiagram: true })).toBe('description')
    expect(grownContent({ remote: false, loading: true, hasDiagram: false })).toBe('drawing')
    expect(grownContent({ remote: false, loading: false, hasDiagram: true })).toBe('diagram')
    expect(grownContent({ remote: false, loading: false, hasDiagram: false })).toBe('description')
  })
})

function run(events: Array<[HoverEvent, number]>, start: HoverState = HOVER_IDLE): HoverState {
  return events.reduce((state, [event, now]) => hoverReduce(state, event, now), start)
}

const enter = (cellId: string): HoverEvent => ({ type: 'enter', cellId })
const leave = (cellId: string): HoverEvent => ({ type: 'leave', cellId })
const TICK: HoverEvent = { type: 'tick' }

describe('hoverReduce', () => {
  it('grows only after the delay', () => {
    const pending = run([[enter('a'), 1000]])
    expect(pending).toEqual({ kind: 'pending', cellId: 'a', since: 1000, grown: null })
    expect(grownCellId(pending)).toBeNull()
    expect(hoverDeadline(pending)).toBe(1000 + HOVER_GROW_DELAY_MS)
    expect(hoverReduce(pending, TICK, 1000 + HOVER_GROW_DELAY_MS - 1)).toBe(pending)
    const open = hoverReduce(pending, TICK, 1000 + HOVER_GROW_DELAY_MS)
    expect(grownCellId(open)).toBe('a')
    expect(hoverDeadline(open)).toBeNull()
  })

  it('a quick sweep across many cells never grows anything', () => {
    const events: Array<[HoverEvent, number]> = []
    const step = 50
    const cells = ['a', 'b', 'c', 'd', 'e', 'f']
    cells.forEach((id, i) => {
      events.push([enter(id), i * step], [TICK, i * step + step - 1], [leave(id), i * step + step - 1])
    })
    let state: HoverState = HOVER_IDLE
    for (const [event, now] of events) {
      state = hoverReduce(state, event, now)
      expect(grownCellId(state)).toBeNull()
    }
    expect(state).toEqual(HOVER_IDLE)
    expect(hoverDeadline(state)).toBeNull()
  })

  it('entering another cell while pending restarts the delay on it', () => {
    const state = run([[enter('a'), 0], [enter('b'), 200]])
    expect(state).toEqual({ kind: 'pending', cellId: 'b', since: 200, grown: null })
    expect(grownCellId(hoverReduce(state, TICK, HOVER_GROW_DELAY_MS))).toBeNull()
    expect(grownCellId(hoverReduce(state, TICK, 200 + HOVER_GROW_DELAY_MS))).toBe('b')
  })

  it('moving off a grown cell onto a neighbour keeps it grown until the neighbour’s pause ends', () => {
    const opened = run([[enter('a'), 0], [TICK, HOVER_GROW_DELAY_MS]])
    const passing = run([[leave('a'), 400], [enter('b'), 401]], opened)
    expect(passing).toEqual({ kind: 'pending', cellId: 'b', since: 401, grown: 'a' })
    expect(grownCellId(passing)).toBe('a')
    // The pause ends: the grow MOVES to b in one step.
    expect(grownCellId(hoverReduce(passing, TICK, 401 + HOVER_GROW_DELAY_MS))).toBe('b')
  })

  it('passing through a neighbour to the bare sheet shrinks the grown cell after the grace', () => {
    const state = run([
      [enter('a'), 0],
      [TICK, HOVER_GROW_DELAY_MS],
      [leave('a'), 400],
      [enter('b'), 401],
      [leave('b'), 450],
    ])
    expect(state).toEqual({ kind: 'closing', cellId: 'a', since: 450 })
    expect(grownCellId(state)).toBe('a')
    expect(hoverDeadline(state)).toBe(450 + HOVER_CLOSE_GRACE_MS)
    expect(hoverReduce(state, TICK, 450 + HOVER_CLOSE_GRACE_MS - 1)).toBe(state)
    expect(hoverReduce(state, TICK, 450 + HOVER_CLOSE_GRACE_MS)).toEqual(HOVER_IDLE)
  })

  it('coming back onto the grown cell from a neighbour needs no pause', () => {
    const state = run([[enter('a'), 0], [TICK, HOVER_GROW_DELAY_MS], [leave('a'), 400], [enter('b'), 401], [leave('b'), 420], [enter('a'), 421]])
    expect(state).toEqual({ kind: 'open', cellId: 'a' })
  })

  it('leaving a grown cell shrinks it after the grace; returning within it keeps it', () => {
    const left = run([[enter('a'), 0], [TICK, HOVER_GROW_DELAY_MS], [leave('a'), 400]])
    expect(left).toEqual({ kind: 'closing', cellId: 'a', since: 400 })
    expect(run([[enter('a'), 450]], left)).toEqual({ kind: 'open', cellId: 'a' })
    expect(hoverReduce(left, TICK, 400 + HOVER_CLOSE_GRACE_MS)).toEqual(HOVER_IDLE)
  })

  it('leaving a pending cell cancels it; a stale leave from another cell is ignored', () => {
    expect(run([[enter('a'), 0], [leave('a'), 100]])).toEqual(HOVER_IDLE)
    const pending = run([[enter('b'), 0], [leave('a'), 10]])
    expect(pending).toEqual({ kind: 'pending', cellId: 'b', since: 0, grown: null })
  })

  it('escape and reset put the map back from any state', () => {
    const open = run([[enter('a'), 0], [TICK, HOVER_GROW_DELAY_MS]])
    expect(hoverReduce(open, { type: 'escape' }, 500)).toEqual(HOVER_IDLE)
    expect(hoverReduce(open, { type: 'reset' }, 500)).toEqual(HOVER_IDLE)
    expect(hoverReduce(run([[enter('a'), 0]]), { type: 'reset' }, 10)).toEqual(HOVER_IDLE)
    const passing = run([[leave('a'), 400], [enter('b'), 401]], open)
    expect(grownCellId(hoverReduce(passing, { type: 'escape' }, 402))).toBeNull()
  })

  it('a tick with nothing pending does nothing', () => {
    expect(hoverReduce(HOVER_IDLE, TICK, 0)).toBe(HOVER_IDLE)
    const open = run([[enter('a'), 0], [TICK, HOVER_GROW_DELAY_MS]])
    expect(hoverReduce(open, TICK, 99_999)).toBe(open)
  })
})

describe('isLayoutEcho — the map moving under a still pointer', () => {
  it('is an echo only at the same spot, while a re-layout is in flight', () => {
    const last = { x: 300, y: 200 }
    expect(isLayoutEcho(last, { x: 300, y: 200 }, 1000, 1200)).toBe(true)
    expect(isLayoutEcho(last, { x: 300.4, y: 199.7 }, 1000, 1200)).toBe(true)
  })

  it('is real movement when the pointer moved, when the map is still, or with no mark yet', () => {
    expect(isLayoutEcho({ x: 300, y: 200 }, { x: 305, y: 200 }, 1000, 1200)).toBe(false)
    expect(isLayoutEcho({ x: 300, y: 200 }, { x: 300, y: 200 }, 1200, 1200)).toBe(false)
    expect(isLayoutEcho(null, { x: 300, y: 200 }, 1000, 1200)).toBe(false)
  })
})

describe('siblingDiagramRoot — where a Workspace cell reads its diagram', () => {
  const open = new Set(['/repos/billing'])

  it('reads the current project, and a sibling whose checkout is open in Flow', () => {
    expect(siblingDiagramRoot({ local: '/repos/app', current: true }, new Set())).toBe('/repos/app')
    expect(siblingDiagramRoot({ local: '/repos/billing', current: false }, open)).toBe('/repos/billing')
  })

  it('has no diagram for a checkout Flow does not have open, nor for a project not on this computer', () => {
    expect(siblingDiagramRoot({ local: '/repos/ledger', current: false }, open)).toBeNull()
    expect(siblingDiagramRoot({ local: null, current: false }, open)).toBeNull()
  })
})
