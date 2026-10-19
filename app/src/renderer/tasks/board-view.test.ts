import { BOARD_LANES, moveFailureMessage, resolveBoardView } from './board-view'

describe('resolveBoardView (#205)', () => {
  it('shows the lanes board on a successful load (even when empty)', () => {
    expect(resolveBoardView(true, false)).toBe('board')
  })

  it('shows a distinct load-error view when the task list failed to load', () => {
    expect(resolveBoardView(true, true)).toBe('load-error')
  })

  it('shows "no project" — and a stale load error never masks it', () => {
    expect(resolveBoardView(false, false)).toBe('no-project')
    expect(resolveBoardView(false, true)).toBe('no-project') // no-project wins
  })
})

describe('BOARD_LANES', () => {
  it('is five columns, Blocked then Review between Doing and Done', () => {
    // Order is the assertion: Blocked describes work that STARTED and is now
    // waiting on a person; Review describes work FINISHED with a pull request
    // open, waiting on a person to merge — so it belongs after Blocked and just
    // before Done. Anything that renders lanes reads this order.
    expect(BOARD_LANES.map((lane) => lane.key)).toEqual([
      'todo',
      'doing',
      'blocked',
      'review',
      'done',
    ])
  })

  it('labels each column, with Blocked and Review spelled plainly', () => {
    expect(BOARD_LANES.map((lane) => lane.label)).toEqual([
      'Todo',
      'Doing',
      'Blocked',
      'Review',
      'Done',
    ])
  })

  it('names every lane exactly once — a lane rendered twice would split a card', () => {
    expect(new Set(BOARD_LANES.map((lane) => lane.key)).size).toBe(BOARD_LANES.length)
  })
})

describe('moveFailureMessage — the toast names where the card actually IS (#1687)', () => {
  it('speaks the ORIGIN lane the caller captured, never the failed target', () => {
    // The regression: a To Do → Done drag whose write failed toasted
    // "stayed in Done" because task.lane had already been optimistically
    // overwritten. The message is built from the captured origin, so the
    // words cannot depend on when the optimistic update ran.
    expect(moveFailureMessage('Ship the fix', 'To Do', 'IPC unavailable')).toBe(
      'Ship the fix stayed in To Do — IPC unavailable',
    )
  })

  it('an untitled task still gets a sentence', () => {
    expect(moveFailureMessage('', 'Doing', 'store write failed')).toBe(
      'The task stayed in Doing — store write failed',
    )
  })
})
