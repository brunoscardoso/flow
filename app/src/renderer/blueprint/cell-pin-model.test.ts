import { PAN_START_PX } from './camera'
import {
  diagramClick,
  focusOf,
  hoverWhilePinned,
  outsideClick,
  pinFitCamera,
  pinOpeningCamera,
  PIN_FIT_PADDING_PX,
  PIN_OPEN_INSET_PX,
  PIN_OPEN_SCALE,
  pressWasDrag,
  previewCamera,
  spaceAction,
  wheelZoomFactor,
  zoomPercent,
} from './cell-pin-model'

describe('previewCamera', () => {
  it('centres the scaled diagram in the room', () => {
    expect(previewCamera({ width: 200, height: 100 }, { width: 400, height: 300 }, 1)).toEqual({ k: 1, x: 100, y: 100 })
  })
  it('never offsets below zero', () => {
    expect(previewCamera({ width: 1000, height: 1000 }, { width: 400, height: 300 }, 1)).toEqual({ k: 1, x: 0, y: 0 })
  })
})

describe('pinOpeningCamera', () => {
  it('opens a big diagram readable, at its top-left', () => {
    const cam = pinOpeningCamera({ width: 1600, height: 900 }, { width: 600, height: 400 }, 0.3)
    expect(cam.k).toBe(PIN_OPEN_SCALE)
    expect(cam.x).toBe(PIN_OPEN_INSET_PX)
    expect(cam.y).toBe(PIN_OPEN_INSET_PX)
  })
  it('keeps a preview scale that was already larger, up to natural size', () => {
    expect(pinOpeningCamera({ width: 100, height: 100 }, { width: 600, height: 400 }, 0.95).k).toBe(0.95)
    expect(pinOpeningCamera({ width: 100, height: 100 }, { width: 600, height: 400 }, 1.4).k).toBe(1)
  })
  it('centres an axis that fits, and starts at the edge on one that does not', () => {
    const cam = pinOpeningCamera({ width: 200, height: 1000 }, { width: 600, height: 400 }, 0.2)
    expect(cam.x).toBeCloseTo((600 - 200 * PIN_OPEN_SCALE) / 2)
    expect(cam.y).toBe(PIN_OPEN_INSET_PX)
  })
})

describe('pinFitCamera', () => {
  it('fits all of the diagram inside the room', () => {
    const content = { width: 1600, height: 900 }
    const room = { width: 600, height: 400 }
    const cam = pinFitCamera(content, room)
    expect(cam.x).toBeGreaterThanOrEqual(0)
    expect(cam.y).toBeGreaterThanOrEqual(0)
    expect(cam.x + content.width * cam.k).toBeLessThanOrEqual(room.width + 0.001)
    expect(cam.y + content.height * cam.k).toBeLessThanOrEqual(room.height + 0.001)
    expect(Math.min(cam.x, room.width - cam.x - content.width * cam.k)).toBeGreaterThanOrEqual(PIN_FIT_PADDING_PX - 0.001)
  })
  it('never enlarges a small diagram', () => {
    expect(pinFitCamera({ width: 100, height: 50 }, { width: 600, height: 400 }).k).toBe(1)
  })
})

describe('wheelZoomFactor', () => {
  it('zooms in on a wheel up and out on a wheel down', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeGreaterThan(1)
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeLessThan(1)
  })
  it('reads lines as pixels', () => {
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(
      wheelZoomFactor({ deltaY: 48, deltaMode: 0, ctrlKey: false }),
    )
  })
  it('makes a pinch keener than a wheel of the same delta', () => {
    expect(wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true })).toBeGreaterThan(
      wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: false }),
    )
  })
})

describe('zoomPercent', () => {
  it('rounds to a whole percentage', () => {
    expect(zoomPercent(0.854)).toBe('85%')
    expect(zoomPercent(1)).toBe('100%')
  })
})

describe('pressWasDrag', () => {
  it('uses the camera threshold', () => {
    expect(pressWasDrag(0, 0)).toBe(false)
    expect(pressWasDrag(PAN_START_PX, 0)).toBe(true)
  })
})

describe('diagramClick', () => {
  it('pins an unpinned grown cell with a drawn diagram', () => {
    expect(diagramClick({ pinned: null, cellKey: 'a', drawn: true, dragged: false })).toBe('pin')
    expect(diagramClick({ pinned: 'b', cellKey: 'a', drawn: true, dragged: false })).toBe('pin')
  })
  it('does nothing more on the pinned cell, after a drag, or without a diagram', () => {
    expect(diagramClick({ pinned: 'a', cellKey: 'a', drawn: true, dragged: false })).toBe('none')
    expect(diagramClick({ pinned: null, cellKey: 'a', drawn: true, dragged: true })).toBe('none')
    expect(diagramClick({ pinned: null, cellKey: 'a', drawn: false, dragged: false })).toBe('none')
  })
})

describe('spaceAction', () => {
  it('toggles the pin of an explorable cell', () => {
    expect(spaceAction({ pinned: 'a', cellKey: 'a', drawn: true, canDraw: true })).toBe('unpin')
    expect(spaceAction({ pinned: null, cellKey: 'a', drawn: true, canDraw: true })).toBe('pin')
    expect(spaceAction({ pinned: null, cellKey: 'a', drawn: false, canDraw: true })).toBe('grow-then-pin')
  })
  it('keeps the press for a cell with nothing to explore', () => {
    expect(spaceAction({ pinned: null, cellKey: 'a', drawn: false, canDraw: false })).toBe('press')
  })
})

describe('outsideClick', () => {
  it('leaves the pinned cell its own clicks', () => {
    expect(outsideClick({ pinned: 'a', insidePinned: true, onSheet: true })).toEqual({ unpin: false, swallow: false })
  })
  it('unpins, and swallows a click on the map', () => {
    expect(outsideClick({ pinned: 'a', insidePinned: false, onSheet: true })).toEqual({ unpin: true, swallow: true })
    expect(outsideClick({ pinned: 'a', insidePinned: false, onSheet: false })).toEqual({ unpin: true, swallow: false })
  })
  it('does nothing when nothing is pinned', () => {
    expect(outsideClick({ pinned: null, insidePinned: false, onSheet: true })).toEqual({ unpin: false, swallow: false })
  })
})

describe('hoverWhilePinned', () => {
  it('passes everything when nothing is pinned', () => {
    expect(hoverWhilePinned(null, 'enter')).toBe('pass')
  })
  it('ignores pointers and pauses, and ends on escape or reset', () => {
    expect(hoverWhilePinned('a', 'enter')).toBe('ignore')
    expect(hoverWhilePinned('a', 'leave')).toBe('ignore')
    expect(hoverWhilePinned('a', 'tick')).toBe('ignore')
    expect(hoverWhilePinned('a', 'escape')).toBe('unpin')
    expect(hoverWhilePinned('a', 'reset')).toBe('unpin')
  })
})

describe('focusOf', () => {
  const wires = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a' },
    { from: 'd', to: 'e' },
  ]
  it('lights the component, its wires and the far ends', () => {
    const focus = focusOf('a', wires)
    expect(focus.on).toBe('a')
    expect([...focus.near].sort()).toEqual(['b', 'c'])
    expect([...focus.wires].sort()).toEqual([0, 2])
  })
  it('lights nothing else for a lone component', () => {
    const focus = focusOf('z', wires)
    expect(focus.near.size).toBe(0)
    expect(focus.wires.size).toBe(0)
  })
})
