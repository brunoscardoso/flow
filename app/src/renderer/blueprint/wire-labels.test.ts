import {
  chipBox,
  CHIP_PAD_X,
  CHIP_PAD_Y,
  COST_CARD,
  COST_LABEL,
  COST_PART_LABEL,
  labelOffsets,
  placeWireLabels,
  WIRE_LABEL_STEP,
  type LabelBox,
  type LabelObstacle,
} from './wire-labels'

const box = (y: number, x = 0, w = 100, h = 12): LabelBox => ({ x, y, w, h })
const wall = (y: number, x = 0, w = 100, h = 12, cost = COST_PART_LABEL): LabelObstacle =>
  ({ x, y, w, h, cost })

describe('labelOffsets', () => {
  it('offers home first, then alternates up and down', () => {
    expect(labelOffsets(10, 2)).toEqual([0, -10, 10, -20, 20])
  })
})

describe('chipBox', () => {
  it('grows a text box into the rect that gets drawn around it', () => {
    expect(chipBox({ x: 10, y: 20, w: 100, h: 13 })).toEqual({
      x: 10 - CHIP_PAD_X,
      y: 20 - CHIP_PAD_Y,
      w: 100 + CHIP_PAD_X * 2,
      h: 13 + CHIP_PAD_Y * 2,
    })
  })
})

describe('placeWireLabels', () => {
  it('separates two labels by more than a chip is tall', () => {
    // THE NEAR-MISS. A 10px line of mono measures ~13px, so a chip is ~17 —
    // and the step used to be 15. The pass declared them clear and they were
    // drawn overlapping by two pixels, which from the outside looks exactly
    // like no fix at all.
    const text = { x: 0, y: 100, w: 120, h: 13 }
    const offsets = placeWireLabels([chipBox(text), chipBox(text)], [])
    const gap = Math.abs(offsets[1]! - offsets[0]!)
    expect(gap).toBeGreaterThan(13 + CHIP_PAD_Y * 2)
  })

  it('leaves a label alone when nothing is in its way', () => {
    expect(placeWireLabels([box(100)], [])).toEqual([0])
  })

  it('lifts a label off a province name', () => {
    // The obstacle is the province label row the midpoint landed on.
    const [dy] = placeWireLabels([box(100)], [wall(98, 0, 300, 18)])
    expect(dy).toBe(-WIRE_LABEL_STEP)
  })

  it('prefers covering a cheap thing to covering an expensive one', () => {
    // Above: a card. Below: another label. Neither offer is free, so the pass
    // scores them — and a label is cheaper to disturb than a card, because a
    // chip keeps stacked labels legible and nothing keeps a covered card so.
    // Boxed in on both sides so there is no free offer at all: a card fills
    // everything above and a stack of labels everything below.
    const offsets = placeWireLabels(
      [box(100)],
      [
        { x: 0, y: -100, w: 100, h: 230, cost: COST_CARD },
        { x: 0, y: 130, w: 100, h: 200, cost: COST_LABEL },
      ],
    )
    expect(offsets[0]).toBeGreaterThan(0) // it moved DOWN, onto the cheap thing
  })

  it('still moves when nothing is free, rather than giving up where it stands', () => {
    // THE FIRST-FIT CLIFF. A label with no clear offer used to keep its home —
    // the one place the pass exists to leave. Measured live: adding cards to
    // the obstacle set took a level from 12 label-on-card to 9 on a card PLUS
    // 4 on each other and 2 on a province name.
    const crowded: LabelObstacle[] = [
      { x: 0, y: 60, w: 100, h: 80, cost: COST_CARD }, // covers home densely
      { x: 0, y: 150, w: 100, h: 8, cost: COST_LABEL }, // a thin, cheap strip
    ]
    const [dy] = placeWireLabels([box(100)], crowded)
    expect(dy).not.toBe(0)
  })

  it('never resolves two labels onto each other', () => {
    const offsets = placeWireLabels([box(100), box(100), box(100)], [])
    const placed = offsets.map((dy) => 100 + dy)
    expect(new Set(placed).size).toBe(3)
    expect(offsets[0]).toBe(0) // the first keeps its home
  })

  it('never lifts a label off the top of its own sheet', () => {
    // Everything this pass avoids is INSIDE the canvas, so without bounds an
    // offer that leaves it scores zero and wins — and the label lands on
    // whatever the level draws above. Live: the part level's summary prose.
    const label = chipBox({ x: 0, y: 8, w: 120, h: 13 })
    const wall: LabelObstacle[] = [{ x: 0, y: 0, w: 400, h: 200, cost: COST_CARD }]
    const [dy] = placeWireLabels([label], wall, WIRE_LABEL_STEP, 8, { top: 0, bottom: 300 })
    expect(label.y + dy!).toBeGreaterThanOrEqual(0)
  })

  it('never pushes one off the bottom either', () => {
    const label = chipBox({ x: 0, y: 280, w: 120, h: 13 })
    const wall: LabelObstacle[] = [{ x: 0, y: 0, w: 400, h: 400, cost: COST_CARD }]
    const [dy] = placeWireLabels([label], wall, WIRE_LABEL_STEP, 8, { top: 0, bottom: 300 })
    expect(label.y + dy! + label.h).toBeLessThanOrEqual(300)
  })

  it('is deterministic — same boxes in, same offsets out', () => {
    const labels = [box(100), box(104), box(160), box(101)]
    const obstacles = [wall(98, 0, 400, 18)]
    expect(placeWireLabels(labels, obstacles)).toEqual(placeWireLabels(labels, obstacles))
  })

  it('stays home rather than disappearing when nothing is clear', () => {
    // A wall of obstacles across every offer: the label keeps its own place and
    // relies on its chip. Hiding it would drop the answer the reader came for.
    const boxed = [-45, -30, -15, 0, 15, 30, 45].map((dy) => wall(100 + dy, 0, 400, 15, COST_CARD))
    // Every offer costs the same, so the tie-break keeps it home.
    expect(placeWireLabels([box(100)], boxed, 15, 3)).toEqual([0])
  })

  it('ignores a box that is beside it rather than under it', () => {
    // Horizontal separation is not a collision — a lane can hold two labels.
    expect(placeWireLabels([box(100, 0, 50)], [wall(100, 200, 50)])).toEqual([0])
  })
})
