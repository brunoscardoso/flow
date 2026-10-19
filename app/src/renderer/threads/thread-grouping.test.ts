// thread-grouping — count-based cap that drives the sidebar's pinned + visible
// + "Show N more" bands (#71).

import type { ThreadSummary } from '../../shared/ipc-contract'
import {
  capThreadList,
  sidebarRowHeight,
  DEFAULT_VISIBLE_LIMIT,
  ROW_CONTEXT_LINE_HEIGHT,
  ROW_LINE_HEIGHT,
  ROW_TEXT_INDENT,
  SIDEBAR_ROW_HEIGHT,
  SIDEBAR_ROW_HEIGHT_WITH_CONTEXT,
} from './thread-grouping'

const NOW = Date.parse('2026-07-11T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

/** Minimal ThreadSummary with a given age (days ago) and pin state. */
function thread(id: string, daysAgo: number, pinned = false): ThreadSummary {
  const updatedAt = new Date(NOW - daysAgo * DAY).toISOString()
  return {
    id,
    projectRoot: '/p',
    title: id,
    sdkSessionId: null,
    model: null,
    effort: null,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    imported: false,
    pinnedAt: pinned ? updatedAt : null,
    bypassPermissions: false,
    additionalRoots: [],
    // Not a loop run — an ordinary conversation, which is what this fixture is.
    originLoop: null,
    originAim: null,
    originKey: null,
    // No checkout of its own — a chat-only thread, which is what this is.
    worktreePath: null,
    worktreeBranch: null,
    worktreeBase: null,
    // …and nothing that never had a checkout ever published anywhere.
    remote: null,
    remoteBranch: null,
    prBase: null,
    previouslyPushedAs: null,
  }
}

describe('capThreadList', () => {
  it('defaults to showing 5 unpinned items, folding the rest under "more"', () => {
    expect(DEFAULT_VISIBLE_LIMIT).toBe(5)
    const threads = Array.from({ length: 8 }, (_, i) => thread(`t${i}`, i)) // t0 newest
    const { pinned, visible, overflowCount } = capThreadList(threads, {
      searching: false,
      expanded: false,
    })
    expect(pinned).toEqual([])
    expect(visible.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']) // newest 5
    expect(overflowCount).toBe(3)
  })

  it('shows everything when expanded (overflowCount still reported)', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread(`t${i}`, i))
    const { visible, overflowCount } = capThreadList(threads, { searching: false, expanded: true })
    expect(visible).toHaveLength(8)
    expect(overflowCount).toBe(3)
  })

  it('never folds when at or under the limit', () => {
    const threads = [thread('a', 1), thread('b', 2), thread('c', 3)]
    const { visible, overflowCount } = capThreadList(threads, { searching: false, expanded: false })
    expect(visible).toHaveLength(3)
    expect(overflowCount).toBe(0)
  })

  it('always surfaces pinned first, and pinned do not count against the limit', () => {
    const threads = [
      thread('p1', 40, true),
      thread('p2', 50, true),
      ...Array.from({ length: 6 }, (_, i) => thread(`t${i}`, i + 1)),
    ]
    const { pinned, visible, overflowCount } = capThreadList(threads, {
      searching: false,
      expanded: false,
    })
    expect(pinned.map((t) => t.id)).toEqual(['p1', 'p2']) // newest-first, cap-exempt
    expect(visible).toHaveLength(5) // 5 of the 6 unpinned
    expect(overflowCount).toBe(1)
  })

  it('bypasses the cap while searching (old threads findable)', () => {
    const threads = Array.from({ length: 20 }, (_, i) => thread(`t${i}`, i))
    const { visible } = capThreadList(threads, { searching: true, expanded: false })
    expect(visible).toHaveLength(20)
  })

  it('reports no overflow while searching so the fold control never renders (#75)', () => {
    const threads = Array.from({ length: 20 }, (_, i) => thread(`t${i}`, i))
    const { overflowCount } = capThreadList(threads, { searching: true, expanded: false })
    expect(overflowCount).toBe(0)
  })

  it('respects a custom limit', () => {
    const threads = Array.from({ length: 5 }, (_, i) => thread(`t${i}`, i))
    const { visible, overflowCount } = capThreadList(threads, {
      searching: false,
      expanded: false,
      limit: 2,
    })
    expect(visible.map((t) => t.id)).toEqual(['t0', 't1'])
    expect(overflowCount).toBe(3)
  })

  it('force-includes the ACTIVE thread past the cap without changing the fold count (#1042)', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread(`t${i}`, i)) // t0 newest
    const { visible, overflowCount } = capThreadList(threads, {
      searching: false,
      expanded: false,
      activeId: 't7', // the oldest — folded away without the exemption
    })
    expect(visible.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4', 't7'])
    // Still counted among the folded items — surfaced, not re-banded — so the
    // "Show N more" label doesn't churn when the user opens an old thread.
    expect(overflowCount).toBe(3)
  })

  it('does not duplicate an active thread already visible or pinned (#1042)', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread(`t${i}`, i))
    const inCap = capThreadList(threads, { searching: false, expanded: false, activeId: 't2' })
    expect(inCap.visible.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4'])

    const withPin = [thread('p1', 40, true), ...threads]
    const pinnedActive = capThreadList(withPin, {
      searching: false,
      expanded: false,
      activeId: 'p1',
    })
    expect(pinnedActive.pinned.map((t) => t.id)).toEqual(['p1'])
    expect(pinnedActive.visible.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4'])
  })

  it('ignores activeId while searching or expanded (everything shows anyway, #1042)', () => {
    const threads = Array.from({ length: 8 }, (_, i) => thread(`t${i}`, i))
    const searching = capThreadList(threads, { searching: true, expanded: false, activeId: 't7' })
    expect(searching.visible).toHaveLength(8)
    const expanded = capThreadList(threads, { searching: false, expanded: true, activeId: 't7' })
    expect(expanded.visible).toHaveLength(8) // no duplicate row for the active one
  })

  it('interleaves tasks and threads by recency, not by type', () => {
    const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()
    const merged = [
      { row: 'task', id: 'task-old', updatedAt: at(3), pinnedAt: null },
      { row: 'thread', id: 'thread-new', updatedAt: at(1), pinnedAt: null },
      { row: 'task', id: 'task-newest', updatedAt: at(0.5), pinnedAt: null },
    ]
    const { visible } = capThreadList(merged, { searching: false, expanded: false })
    expect(visible.map((t) => t.id)).toEqual(['task-newest', 'thread-new', 'task-old'])
  })
})

describe('sidebarRowHeight — the second line is bought, never wrapped (2026-08-26)', () => {
  it('gives a row that names other projects a second line', () => {
    expect(sidebarRowHeight(1)).toBe(SIDEBAR_ROW_HEIGHT_WITH_CONTEXT)
    expect(sidebarRowHeight(6)).toBe(SIDEBAR_ROW_HEIGHT_WITH_CONTEXT)
  })

  it('leaves every other row at the dense height', () => {
    // Project headers, "Show more" and single-project threads all report 0 —
    // buying them a line they do not use is what "make every row two lines"
    // would have cost.
    expect(sidebarRowHeight(0)).toBe(SIDEBAR_ROW_HEIGHT)
  })

  it('is tall enough for both of its lines', () => {
    // <fl-list> CLIPS a row to its measured height, so a height that is merely
    // "bigger" still slices the second line (#1489). The renderer draws two
    // line boxes; this is the arithmetic that has to pay for them.
    expect(SIDEBAR_ROW_HEIGHT_WITH_CONTEXT).toBeGreaterThanOrEqual(
      ROW_LINE_HEIGHT + ROW_CONTEXT_LINE_HEIGHT,
    )
  })

  it('keeps the projects line quieter than the title line', () => {
    // Two lines of equal weight read as two rows, not as one row with a
    // footnote about where else the thread can reach.
    expect(ROW_CONTEXT_LINE_HEIGHT).toBeLessThan(ROW_LINE_HEIGHT)
  })

  it('indents the projects line under the title, not under the glyph', () => {
    // The row's left column belongs to the icons; the text column starts past
    // it, and both lines of text share one left edge.
    expect(ROW_TEXT_INDENT).toBeGreaterThan(0)
    expect(ROW_TEXT_INDENT).toBeLessThan(SIDEBAR_ROW_HEIGHT)
  })

  it('never returns a height the list would reject', () => {
    for (const count of [0, 1, 99]) expect(sidebarRowHeight(count)).toBeGreaterThan(0)
  })
})
