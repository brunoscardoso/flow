import {
  SIDEBAR_ORDERS,
  UNRESOLVED_LIST_KEY,
  archivedToggleLabel,
  archivedToggleTitle,
  carriesViewOptionsForward,
  compareInOrder,
  defaultViewOptions,
  orderLabel,
  readViewOptions,
  viewOptionsStorageKey,
  writeViewOptions,
} from './sidebar-view-options'

const row = (title: string, updatedAt: string, createdAt = '2026-01-01T00:00:00.000Z') => ({
  title,
  updatedAt,
  createdAt,
})

describe('defaults', () => {
  it('is exactly what the sidebar did before it could be asked', () => {
    // A new control must not change what an existing reader sees until they
    // use it.
    expect(defaultViewOptions()).toEqual({ order: 'recent', showArchived: false })
  })

  it('keeps one project\'s answer off another\'s', () => {
    expect(viewOptionsStorageKey('/a')).not.toBe(viewOptionsStorageKey('/b'))
  })
})

describe('readViewOptions', () => {
  it('round-trips what it wrote', () => {
    const wanted = { order: 'name' as const, showArchived: true }
    expect(readViewOptions(writeViewOptions(wanted))).toEqual(wanted)
  })

  it('reads anything it does not recognise as no answer', () => {
    // A value a newer build wrote, a hand-edit, or nothing at all — the list
    // then reads exactly as it did before anybody touched it.
    expect(readViewOptions(null)).toEqual(defaultViewOptions())
    expect(readViewOptions('')).toEqual(defaultViewOptions())
    expect(readViewOptions('not json')).toEqual(defaultViewOptions())
    expect(readViewOptions('[]')).toEqual(defaultViewOptions())
    expect(readViewOptions('{"order":"by-vibes"}')).toEqual(defaultViewOptions())
  })

  it('keeps the half it CAN read', () => {
    expect(readViewOptions('{"order":"by-vibes","showArchived":true}')).toEqual({
      order: 'recent',
      showArchived: true,
    })
  })

  it('treats anything but true as not showing the archive', () => {
    expect(readViewOptions('{"showArchived":"yes"}').showArchived).toBe(false)
  })
})

describe('compareInOrder', () => {
  const older = row('Beta', '2026-05-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  const newer = row('Alpha', '2026-06-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')

  it('recent puts the last-touched first', () => {
    expect([older, newer].sort((a, b) => compareInOrder(a, b, 'recent'))[0]).toBe(newer)
  })

  it('created puts the newest-made first, whatever was touched since', () => {
    const touched = row('Old but busy', '2026-09-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    expect([touched, newer].sort((a, b) => compareInOrder(a, b, 'created'))[0]).toBe(newer)
  })

  it('name sorts by what the reader can actually read', () => {
    expect([older, newer].sort((a, b) => compareInOrder(a, b, 'name'))[0]).toBe(newer)
  })

  it('EVERY order breaks its ties, so the list cannot shuffle under a click', () => {
    // The sidebar re-renders on every thread update; a list that reorders
    // between two identical renders is the defect the board fixed for lanes.
    const same = [row('B', 'T', 'C'), row('A', 'T', 'C')]
    for (const order of SIDEBAR_ORDERS.map((o) => o.value)) {
      const once = [...same].sort((a, b) => compareInOrder(a, b, order)).map((r) => r.title)
      const twice = [...same].reverse().sort((a, b) => compareInOrder(a, b, order)).map((r) => r.title)
      expect(twice).toEqual(once)
    }
  })
})

describe('what the menu says', () => {
  it('names the order that is on', () => {
    expect(orderLabel('recent')).toBe('Last updated')
    expect(orderLabel('name')).toBe('Name')
    expect(orderLabel('created')).toBe('Newest first')
  })

  it('offers recent first — the default, and the one most presses confirm', () => {
    expect(SIDEBAR_ORDERS[0]?.value).toBe('recent')
  })

  it('carries the count, because it is the only sign there is anything there', () => {
    expect(archivedToggleLabel(0)).toBe('Archived (0)')
    expect(archivedToggleLabel(1)).toBe('Archived (1)')
    expect(archivedToggleLabel(4)).toBe('Archived (4)')
  })

  it('says what pressing it does — and says the truth when there is nothing', () => {
    expect(archivedToggleTitle(false, 4)).toBe(
      'Show archived conversations and tasks in this list',
    )
    expect(archivedToggleTitle(true, 4)).toBe(
      'Hide archived conversations and tasks from this list',
    )
    // A control that cannot act owes its reason in its own terms.
    expect(archivedToggleTitle(false, 0)).toBe('Nothing in this project has been archived.')
  })
})

describe('an answer given before the list knew its Workspace', () => {
  const RESOLVED = 'workspace:default'
  const PRESSED = '{"order":"recent","showArchived":true}'

  it('is carried onto the key the list resolved into', () => {
    // The press that was being lost: stored under the placeholder, then read
    // back under a name that had never been written.
    expect(carriesViewOptionsForward(UNRESOLVED_LIST_KEY, RESOLVED, PRESSED, null)).toBe(true)
  })

  it('is not carried over an answer the real list already has', () => {
    expect(
      carriesViewOptionsForward(UNRESOLVED_LIST_KEY, RESOLVED, PRESSED, '{"order":"name"}'),
    ).toBe(false)
  })

  it('is nothing to carry when no press was stored', () => {
    // A key populated only by READING defaults must not plant a preference on
    // every Workspace the reader passes through.
    expect(carriesViewOptionsForward(UNRESOLVED_LIST_KEY, RESOLVED, null, null)).toBe(false)
  })

  it('is never carried between two real Workspaces', () => {
    // Switching Workspace is not a resolve, and one Workspace's answer is not
    // evidence about another's.
    expect(carriesViewOptionsForward('workspace:alpha', 'workspace:beta', PRESSED, null)).toBe(
      false,
    )
  })

  it('is not carried when the scope resolved to nothing at all', () => {
    expect(
      carriesViewOptionsForward(UNRESOLVED_LIST_KEY, UNRESOLVED_LIST_KEY, PRESSED, null),
    ).toBe(false)
  })

  it('keys the placeholder exactly as the list spells it', () => {
    // The sidebar builds this same string from an unresolved scope; if the two
    // drift, the carry silently never matches.
    expect(UNRESOLVED_LIST_KEY).toBe('workspace:')
    expect(viewOptionsStorageKey(UNRESOLVED_LIST_KEY)).toBe('flow.sidebar.view:workspace:')
  })
})
