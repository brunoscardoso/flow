import {
  MAX_SPLIT_PANES,
  groupKey,
  isUsableSizes,
  parseSplitSizes,
  addTerminal,
  canSplit,
  groupOf,
  neighborInGroup,
  pruneLayout,
  removeTerminal,
  splitBeside,
  visiblePanes,
  type SplitLayout,
  parseArrangement,
  restoreLayout,
} from './terminal-split'

// #1133: the panel could only ever show one terminal — comparing a server log
// against a test run meant flipping tabs back and forth.

const all = (): boolean => true

describe('addTerminal (#1133)', () => {
  it('starts every terminal in its own group — the pre-split behaviour', () => {
    let layout: SplitLayout = []
    layout = addTerminal(layout, 'a')
    layout = addTerminal(layout, 'b')
    expect(layout).toEqual([['a'], ['b']])
  })

  it('is idempotent, so a re-announced terminal never doubles', () => {
    const layout = addTerminal(addTerminal([], 'a'), 'a')
    expect(layout).toEqual([['a']])
  })
})

describe('splitBeside (#1133)', () => {
  it('lands the new pane where the user is looking, not at the end', () => {
    const layout = splitBeside([['a', 'c']], 'a', 'b')
    expect(layout).toEqual([['a', 'b', 'c']])
  })

  it('never drops the new terminal when the anchor is unknown', () => {
    // Fail-open: an unknown anchor must still leave the terminal reachable.
    expect(splitBeside([['a']], 'ghost', 'b')).toEqual([['a'], ['b']])
  })

  it('moves a terminal that was already elsewhere rather than duplicating it', () => {
    expect(splitBeside([['a'], ['b']], 'a', 'b')).toEqual([['a', 'b']])
  })

  it('falls back to its own group once the row is full', () => {
    const full = [['a', 'b', 'c', 'd']]
    expect(full[0]).toHaveLength(MAX_SPLIT_PANES)
    expect(splitBeside(full, 'a', 'e')).toEqual([['a', 'b', 'c', 'd'], ['e']])
  })
})

describe('removeTerminal (#1133)', () => {
  it('collapses the row and drops a group that empties', () => {
    expect(removeTerminal([['a', 'b'], ['c']], 'b')).toEqual([['a'], ['c']])
    expect(removeTerminal([['a'], ['c']], 'c')).toEqual([['a']])
  })
})

describe('visiblePanes (#1133)', () => {
  it('shows the active terminal’s whole group side by side', () => {
    expect(visiblePanes([['a', 'b'], ['c']], 'b', all)).toEqual(['a', 'b'])
  })

  it('switches groups implicitly when a tab outside the row is selected', () => {
    expect(visiblePanes([['a', 'b'], ['c']], 'c', all)).toEqual(['c'])
  })

  it('honours tab visibility, so an out-of-scope terminal never renders a pane', () => {
    // Scope hides tabs without killing PTYs — a hidden member must not occupy
    // a pane it can't be reached from.
    expect(visiblePanes([['a', 'b']], 'a', (id) => id !== 'b')).toEqual(['a'])
  })

  it('shows nothing with no active terminal', () => {
    expect(visiblePanes([['a']], null, all)).toEqual([])
  })
})

describe('neighborInGroup (#1133)', () => {
  it('prefers the right-hand pane, then the left — the tab-strip rule', () => {
    expect(neighborInGroup([['a', 'b', 'c']], 'b')).toBe('c')
    expect(neighborInGroup([['a', 'b', 'c']], 'c')).toBe('b')
  })

  it('is null for a lone terminal, leaving the cross-group fallback in charge', () => {
    expect(neighborInGroup([['a'], ['b']], 'a')).toBeNull()
  })
})

describe('canSplit (#1133)', () => {
  it('is offered for a terminal with room beside it', () => {
    expect(canSplit([['a']], 'a')).toBe(true)
  })

  it('is withheld at the pane cap and with nothing active', () => {
    expect(canSplit([['a', 'b', 'c', 'd']], 'a')).toBe(false)
    expect(canSplit([['a']], null)).toBe(false)
  })
})

describe('pruneLayout (#1133)', () => {
  it('drops terminals that died elsewhere, so no phantom pane survives', () => {
    // A PTY exit or a scope teardown removes tabs without going through close.
    expect(pruneLayout([['a', 'b'], ['c']], new Set(['a', 'c']))).toEqual([['a'], ['c']])
  })
})

describe('groupOf (#1133)', () => {
  it('finds the row a terminal belongs to, null when it belongs to none', () => {
    expect(groupOf([['a', 'b']], 'b')).toEqual(['a', 'b'])
    expect(groupOf([['a']], 'z')).toBeNull()
  })
})

describe('divider ratios (#1294)', () => {
  // A tuned 82/18 row came back 50/50 after visiting a sibling tab, because
  // renderPanes empties <fl-split> and its rebuild resets sizes on any
  // pane-count change. Hiding the whole panel kept the ratio — the same
  // control was inconsistent with itself.
  it('keys a row by its MEMBERS, not their order', () => {
    // The row is the same row whether you split left-to-right or the reverse.
    expect(groupKey(['a', 'b'])).toBe(groupKey(['b', 'a']))
    expect(groupKey(['a', 'b'])).not.toBe(groupKey(['a', 'c']))
  })

  it('only applies sizes that actually describe the row', () => {
    expect(isUsableSizes([0.8, 0.2], 2)).toBe(true)
    // A different pane count is not this row's ratio.
    expect(isUsableSizes([0.8, 0.2], 3)).toBe(false)
    // A single pane has no divider to remember.
    expect(isUsableSizes([1], 1)).toBe(false)
    // Junk never reaches fl-split.
    expect(isUsableSizes([0.5, Number.NaN], 2)).toBe(false)
    expect(isUsableSizes([0.5, 0], 2)).toBe(false)
    expect(isUsableSizes([0.5, -0.5], 2)).toBe(false)
    expect(isUsableSizes('nope', 2)).toBe(false)
  })

  it('survives a corrupt store without costing the panel', () => {
    expect(parseSplitSizes(null)).toEqual({})
    expect(parseSplitSizes('not json')).toEqual({})
    expect(parseSplitSizes('[1,2]')).toEqual({})
    expect(parseSplitSizes('{"row":"nope"}')).toEqual({})
  })

  it('round-trips a real entry, dropping a malformed sibling', () => {
    const stored = JSON.stringify({ 'a b': [0.82, 0.18], bad: [0, 1] })
    expect(parseSplitSizes(stored)).toEqual({ 'a b': [0.82, 0.18] })
  })
})

// ── #1445 — the arrangement across a reload ─────────────────────────────────

describe('parseArrangement (#1445)', () => {
  it('reads back what the panel wrote', () => {
    const raw = JSON.stringify({ layout: [['a', 'b'], ['c']], titles: { a: 'server' } })
    expect(parseArrangement(raw)).toEqual({ layout: [['a', 'b'], ['c']], titles: { a: 'server' } })
  })

  it('is empty for a missing entry', () => {
    expect(parseArrangement(null)).toEqual({ layout: [], titles: {} })
  })

  it('survives corruption rather than taking the panel down with it', () => {
    for (const raw of ['not json', '[]', 'null', '"a string"', '{"layout":42}']) {
      expect(parseArrangement(raw)).toEqual({ layout: [], titles: {} })
    }
  })

  it('drops non-string ids, empty groups and non-string titles', () => {
    const raw = JSON.stringify({
      layout: [['a', 7, null], [], 'nope', ['b']],
      titles: { a: 'ok', b: 42, c: '' },
    })
    expect(parseArrangement(raw)).toEqual({ layout: [['a'], ['b']], titles: { a: 'ok' } })
  })
})

describe('restoreLayout (#1445)', () => {
  it('puts a split row back', () => {
    expect(restoreLayout([['a', 'b']], new Set(['a', 'b']))).toEqual([['a', 'b']])
  })

  it('drops terminals that no longer exist — ids never come back', () => {
    // 'b' was killed; its row must not be rebuilt out of a ghost.
    expect(restoreLayout([['a', 'b'], ['c']], new Set(['a', 'c']))).toEqual([['a'], ['c']])
  })

  it('still shows a terminal the save never knew about', () => {
    // Created after the last save, or by another window: it gets its own group
    // rather than silently vanishing because the arrangement omitted it.
    expect(restoreLayout([['a']], new Set(['a', 'z']))).toEqual([['a'], ['z']])
  })

  it('is the plain one-group-each layout when nothing was saved', () => {
    expect(restoreLayout([], new Set(['a', 'b']))).toEqual([['a'], ['b']])
  })

  it('drops a saved row whose terminals are all gone', () => {
    expect(restoreLayout([['x', 'y']], new Set(['a']))).toEqual([['a']])
  })
})
