import {
  cardDeleteConfirm,
  cardRemovalItems,
  huntMenuItems,
  laneMenuItems,
  laneName,
} from './lane-menu-model'

describe('laneMenuItems (#1153)', () => {
  it('offers every lane in board order, whichever one the task is in', () => {
    expect(laneMenuItems('doing').map((i) => i.lane)).toEqual([
      'todo',
      'doing',
      'blocked',
      'review',
      'done',
    ])
    expect(laneMenuItems('done').map((i) => i.lane)).toEqual([
      'todo',
      'doing',
      'blocked',
      'review',
      'done',
    ])
  })

  it('marks the current lane and only that one', () => {
    const items = laneMenuItems('doing')
    expect(items.filter((i) => i.current).map((i) => i.lane)).toEqual(['doing'])
  })

  it('marks Blocked when the task is in it', () => {
    // The fourth lane is a real drop target on the board, so the menu has to be
    // able to SAY a task is in it — otherwise the one lane a card can land in
    // by accident is the one the menu can't name.
    expect(laneMenuItems('blocked').filter((i) => i.current).map((i) => i.lane)).toEqual([
      'blocked',
    ])
  })

  it('keeps the current lane in the list, so the menu also SAYS where the task is', () => {
    // Hiding it would make positions shift between cards and would leave the
    // "which lane is this in?" question — the one the detail modal couldn't
    // answer at all — still unanswered.
    expect(laneMenuItems('todo')).toHaveLength(5)
  })

  it('speaks the sidebar’s vocabulary, so the two surfaces read identically', () => {
    expect(laneMenuItems('todo').map((i) => i.label)).toEqual([
      'Move to Todo',
      'Move to Doing',
      'Move to Blocked',
      'Move to Review',
      'Move to Done',
    ])
  })

  it('laneName is the status readout, not the move verb', () => {
    expect(laneName('todo')).toBe('Todo')
    expect(laneName('doing')).toBe('Doing')
    expect(laneName('blocked')).toBe('Blocked')
    expect(laneName('review')).toBe('Review')
    expect(laneName('done')).toBe('Done')
  })
})

describe('getting a card off the board', () => {
  it('offers archive then delete, in escalating order', () => {
    expect(cardRemovalItems(false).map((item) => item.id)).toEqual(['archive', 'delete'])
  })

  it('marks ONLY the delete as destructive', () => {
    // Archive keeps the record, the chat, the brief and the link, and the
    // sidebar can undo it. Painting both red would say they cost the same.
    const [archive, remove] = cardRemovalItems(false)
    expect(archive.danger).toBe(false)
    expect(remove.danger).toBe(true)
  })

  it('offers the way BACK for an archived task', () => {
    // #1466's finding, on the other surface: an Archive with no Unarchive is a
    // one-way trip wearing a reversible word.
    expect(cardRemovalItems(true)[0]?.label).toBe('Unarchive')
    expect(cardRemovalItems(false)[0]?.label).toBe('Archive')
  })

  it('names what is being deleted, and offers a safe way out', () => {
    const confirm = cardDeleteConfirm('Tenant alias drift')
    expect(confirm.question).toContain('Tenant alias drift')
    expect(confirm.question).toContain('its chat')
    expect(confirm.confirm).toBe('Delete both')
    expect(confirm.cancel).toBe('Cancel')
  })

  it('still names something for a card with no title', () => {
    expect(cardDeleteConfirm('').question).toContain('Untitled task')
  })
})

describe('the hunt card’s menu', () => {
  it('offers the run, the filings, and the end — in that order', () => {
    expect(huntMenuItems(true, true).map((item) => item.id)).toEqual([
      'open-run',
      'filter',
      'finish',
    ])
  })

  it('will not finish a hunt that is already finished, and says why', () => {
    const finished = huntMenuItems(true, true, true).find((item) => item.id === 'finish')
    expect(finished?.enabled).toBe(false)
    expect(finished?.blockedReason).toContain('already finished')
  })

  it('keeps an entry that cannot be pressed, carrying its reason', () => {
    // An absent entry teaches the reader the act does not exist; a disabled one
    // with a reason says why not — the panel's rule, on a third surface.
    const [run, filter] = huntMenuItems(false, false)
    expect(huntMenuItems(false, false)).toHaveLength(3)
    expect(run.enabled).toBe(false)
    expect(run.blockedReason).toContain('has been run')
    expect(filter.enabled).toBe(false)
    expect(filter.blockedReason).toContain('filed anything')
  })

  it('never offers to change what the loops are looking for', () => {
    // Nothing in this app may quietly rewrite a project's standing instructions
    // from a right-click: that is a committed setting other machines read.
    const labels = huntMenuItems(true, true).map((item) => item.label.toLowerCase())
    expect(labels.some((label) => /edit|change|rename/.test(label))).toBe(false)
  })
})
