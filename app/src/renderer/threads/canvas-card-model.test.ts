import { CanvasOpenLedger, canvasCardView, canvasesInPaths } from './canvas-card-model'

describe('canvasesInPaths', () => {
  it('finds each canvas once, with the project it lives in', () => {
    expect(
      canvasesInPaths([
        '/p/app/flow/drafts/desks-naming/layout.json',
        '/p/app/flow/drafts/desks-naming/tokens.css',
        '/p/app/src/index.ts',
        '/p/core/flow/drafts/checkout/home.html',
      ]),
    ).toEqual([
      { root: '/p/app', canvas: 'desks-naming' },
      { root: '/p/core', canvas: 'checkout' },
    ])
  })

  it('ignores a file directly in the drafts folder and a slug the drafts code refuses', () => {
    expect(canvasesInPaths(['/p/flow/drafts/notes.md', '/p/flow/drafts/Bad Name/x.html'])).toEqual([])
  })

  it('reads Windows separators', () => {
    expect(canvasesInPaths(['C:\\p\\flow\\drafts\\pay\\layout.json'])).toEqual([{ root: 'C:/p', canvas: 'pay' }])
  })
})

describe('canvasCardView', () => {
  it('shows the slug until the canvas has been read', () => {
    expect(canvasCardView('pay', undefined, false)).toEqual({ title: 'pay', detail: 'Canvas', canOpen: true })
    expect(canvasCardView('pay', undefined, true)).toMatchObject({ detail: 'Writing the canvas…', canOpen: false })
  })

  it('counts the screens while the request still writes them', () => {
    expect(canvasCardView('pay', { name: 'Payments', screenCount: 7, screensWritten: 3 }, true)).toEqual({
      title: 'Payments',
      detail: 'Writing the canvas… 3 of 7 screens',
      canOpen: false,
    })
  })

  it('opens once complete, and once the request ended even if screens are missing', () => {
    expect(canvasCardView('pay', { name: 'Payments', screenCount: 7, screensWritten: 7 }, true)).toEqual({
      title: 'Payments',
      detail: 'Canvas · 7 screens',
      canOpen: true,
    })
    expect(canvasCardView('pay', { screenCount: 1, screensWritten: 0 }, false)).toMatchObject({ detail: 'Canvas · 1 screen', canOpen: true })
  })

  it('says what is wrong with an unreadable layout and still opens', () => {
    expect(canvasCardView('pay', { screenCount: 0, problem: 'The layout is not valid JSON.' }, false)).toEqual({
      title: 'pay',
      detail: 'The layout is not valid JSON.',
      canOpen: true,
    })
  })
})

describe('CanvasOpenLedger', () => {
  const written = { root: '/p', canvas: 'pay' }

  it('opens nothing before a turn ends', () => {
    expect(new CanvasOpenLedger().take('t1', ['m1'], written)).toBe(false)
  })

  it('opens the canvas of the request that ended the turn, once', () => {
    const ledger = new CanvasOpenLedger()
    ledger.turnEnded('t1', 'm2')
    // An older request of the same conversation does not open.
    expect(ledger.take('t1', ['m1'], written)).toBe(false)
    expect(ledger.take('t1', ['m1', 'm2'], written)).toBe(true)
    // A rebuild of the same request does not open it again.
    expect(ledger.take('t1', ['m1', 'm2'], written)).toBe(false)
    // Another conversation is not this one.
    expect(ledger.take('t2', ['m2'], written)).toBe(false)
  })
})
