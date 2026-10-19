// Peek-drawer model — pure logic, no DOM (node env). Exhaustively covers the
// state machine (closed → open → swap → close) and the size persistence
// parse/clamp/serialize path (defaults, normalize, floor/ceil, corrupt input).

import {
  MIN_PEEK_FRACTION,
  PEEK_CLOSED,
  PEEK_DEFAULT_SIZES,
  PEEK_STORAGE_KEY,
  clampPeekSizes,
  isPeekSwap,
  parsePeekSizes,
  sizesKeepingStage,
  peekReduce,
  serializePeekSizes,
  type PeekState,
} from './peek-model'

describe('peek state machine', () => {
  it('starts closed with no path, full mode, no verdict', () => {
    expect(PEEK_CLOSED).toEqual({ open: false, path: null, mode: 'full', verdict: null })
  })

  it('opens from closed to a path in full mode with no verdict', () => {
    const next = peekReduce(PEEK_CLOSED, { type: 'open', path: 'app/src/a.ts' })
    expect(next).toEqual({ open: true, path: 'app/src/a.ts', mode: 'full', verdict: null })
  })

  it('swaps the path while already open', () => {
    const open = peekReduce(PEEK_CLOSED, { type: 'open', path: 'a.ts' })
    const swapped = peekReduce(open, { type: 'open', path: 'b.ts' })
    expect(swapped).toEqual({ open: true, path: 'b.ts', mode: 'full', verdict: null })
  })

  it('is idempotent when opening the same path', () => {
    const open = peekReduce(PEEK_CLOSED, { type: 'open', path: 'a.ts' })
    const again = peekReduce(open, { type: 'open', path: 'a.ts' })
    expect(again).toEqual({ open: true, path: 'a.ts', mode: 'full', verdict: null })
  })

  it('resets mode and verdict when a new path opens', () => {
    const diffing = peekReduce(
      { open: true, path: 'a.ts', mode: 'diff', verdict: 'refused' },
      { type: 'open', path: 'b.ts' },
    )
    expect(diffing).toEqual({ open: true, path: 'b.ts', mode: 'full', verdict: null })
  })

  it('closes from open back to the canonical closed state', () => {
    const open = peekReduce(PEEK_CLOSED, { type: 'open', path: 'a.ts' })
    expect(peekReduce(open, { type: 'close' })).toEqual(PEEK_CLOSED)
  })

  it('close from closed stays closed', () => {
    expect(peekReduce(PEEK_CLOSED, { type: 'close' })).toEqual(PEEK_CLOSED)
  })

  it('never mutates the input state', () => {
    const frozen: PeekState = Object.freeze({ open: false, path: null, mode: 'full', verdict: null })
    expect(() => peekReduce(frozen, { type: 'open', path: 'a.ts' })).not.toThrow()
  })
})

describe('peek mode + verdict', () => {
  const open: PeekState = { open: true, path: 'a.ts', mode: 'full', verdict: null }

  it('toggles mode full → diff and back, preserving path/verdict', () => {
    const toDiff = peekReduce(open, { type: 'toggle-mode' })
    expect(toDiff).toEqual({ open: true, path: 'a.ts', mode: 'diff', verdict: null })
    const backToFull = peekReduce(toDiff, { type: 'toggle-mode' })
    expect(backToFull).toEqual({ open: true, path: 'a.ts', mode: 'full', verdict: null })
  })

  it('sets an explicit mode', () => {
    expect(peekReduce(open, { type: 'set-mode', mode: 'diff' })).toEqual({
      open: true,
      path: 'a.ts',
      mode: 'diff',
      verdict: null,
    })
  })

  it('sets a verdict without touching mode/path', () => {
    const approved = peekReduce(open, { type: 'set-verdict', verdict: 'approved' })
    expect(approved).toEqual({ open: true, path: 'a.ts', mode: 'full', verdict: 'approved' })
    const refused = peekReduce(approved, { type: 'set-verdict', verdict: 'refused' })
    expect(refused.verdict).toBe('refused')
  })

  it('never mutates the input state on an in-place action', () => {
    const frozen: PeekState = Object.freeze({ open: true, path: 'a.ts', mode: 'full', verdict: null })
    expect(() => peekReduce(frozen, { type: 'set-verdict', verdict: 'approved' })).not.toThrow()
  })
})

describe('isPeekSwap', () => {
  it('is a fresh open (not a swap) from closed', () => {
    expect(isPeekSwap(PEEK_CLOSED, { type: 'open', path: 'a.ts' })).toBe(false)
  })

  it('is a swap when already open', () => {
    const open: PeekState = { open: true, path: 'a.ts', mode: 'full', verdict: null }
    expect(isPeekSwap(open, { type: 'open', path: 'b.ts' })).toBe(true)
  })

  it('is never a swap for a close action', () => {
    const open: PeekState = { open: true, path: 'a.ts', mode: 'full', verdict: null }
    expect(isPeekSwap(open, { type: 'close' })).toBe(false)
  })
})

describe('clampPeekSizes', () => {
  it('returns defaults for a non-array', () => {
    expect(clampPeekSizes(null)).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes('0.5,0.5')).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes({})).toEqual([...PEEK_DEFAULT_SIZES])
  })

  it('returns defaults for a wrong-length array', () => {
    expect(clampPeekSizes([0.5])).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes([0.3, 0.3, 0.4])).toEqual([...PEEK_DEFAULT_SIZES])
  })

  it('returns defaults for non-finite or non-positive members', () => {
    expect(clampPeekSizes([Number.NaN, 0.5])).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes([Infinity, 0.5])).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes([0, 0.5])).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes([0.5, -0.2])).toEqual([...PEEK_DEFAULT_SIZES])
    expect(clampPeekSizes(['0.6', '0.4'])).toEqual([...PEEK_DEFAULT_SIZES])
  })

  it('normalizes a valid pair to sum to 1', () => {
    const [main, drawer] = clampPeekSizes([6, 4])
    expect(main + drawer).toBeCloseTo(1)
    expect(drawer).toBeCloseTo(0.4)
  })

  it('floors a too-small drawer fraction to the minimum', () => {
    const [main, drawer] = clampPeekSizes([0.99, 0.01])
    expect(drawer).toBeCloseTo(MIN_PEEK_FRACTION)
    expect(main).toBeCloseTo(1 - MIN_PEEK_FRACTION)
  })

  it('ceils a too-large drawer fraction to the maximum', () => {
    const [main, drawer] = clampPeekSizes([0.01, 0.99])
    expect(drawer).toBeCloseTo(1 - MIN_PEEK_FRACTION)
    expect(main).toBeCloseTo(MIN_PEEK_FRACTION)
  })

  it('preserves the default pair unchanged', () => {
    expect(clampPeekSizes([...PEEK_DEFAULT_SIZES])).toEqual([...PEEK_DEFAULT_SIZES])
  })
})

describe('parsePeekSizes', () => {
  it('returns defaults for null (nothing stored)', () => {
    expect(parsePeekSizes(null)).toEqual([...PEEK_DEFAULT_SIZES])
  })

  it('returns defaults for malformed JSON', () => {
    expect(parsePeekSizes('{ not json')).toEqual([...PEEK_DEFAULT_SIZES])
    expect(parsePeekSizes('')).toEqual([...PEEK_DEFAULT_SIZES])
  })

  it('parses and clamps a valid stored pair', () => {
    expect(parsePeekSizes('[0.7,0.3]')).toEqual([0.7, 0.3])
  })

  it('clamps a degenerate stored pair', () => {
    const [, drawer] = parsePeekSizes('[0.995,0.005]')
    expect(drawer).toBeCloseTo(MIN_PEEK_FRACTION)
  })
})

describe('serializePeekSizes', () => {
  it('round-trips through parse', () => {
    const raw = serializePeekSizes([0.62, 0.38])
    expect(parsePeekSizes(raw)).toEqual([0.62, 0.38])
  })

  it('clamps before serializing', () => {
    const raw = serializePeekSizes([0.99, 0.01])
    const [, drawer] = JSON.parse(raw) as [number, number]
    expect(drawer).toBeCloseTo(MIN_PEEK_FRACTION)
  })
})

describe('storage key', () => {
  it('is the versioned peek key', () => {
    expect(PEEK_STORAGE_KEY).toBe('flow.blueprint.peek.v1')
  })
})

describe('sizesKeepingStage — the stage keeps a floor (2026-08-28)', () => {
  it('leaves fractions alone when the stage already has its room', () => {
    // 600px split, 190px of bar above the stage: 62% = 372px ≥ 190 + 180.
    expect(sizesKeepingStage([0.62, 0.38], 600, 190)).toEqual([0.62, 0.38])
  })
  it('grows pane 1 until the bar plus the floor fit', () => {
    const [main, drawer] = sizesKeepingStage([0.4, 0.6], 600, 190)
    expect(main).toBeCloseTo((190 + 180) / 600, 9)
    expect(main + drawer).toBeCloseTo(1, 9)
  })
  it('lets the stage win on a pane too short for both, keeping the tenant its minimum', () => {
    const [main, drawer] = sizesKeepingStage([0.62, 0.38], 300, 190)
    expect(main).toBeCloseTo(1 - MIN_PEEK_FRACTION, 9)
    expect(drawer).toBeCloseTo(MIN_PEEK_FRACTION, 9)
  })
  it('returns the fractions untouched before the split is laid out', () => {
    expect(sizesKeepingStage([0.62, 0.38], 0, 190)).toEqual([0.62, 0.38])
  })
})
