import { JUMP_VISIBLE_THRESHOLD_PX, jumpToLatestView } from './jump-to-latest'

// #1330: scroll up mid-turn and the app leaves you there with no way back —
// no jump-to-latest, no "new messages" pill, no unread badge, and nothing
// saying the conversation moved on.

describe('jumpToLatestView (#1330)', () => {
  it('stays hidden while auto-follow is engaged', () => {
    expect(jumpToLatestView({ pinned: true, distanceFromBottom: 5000, missed: 9 }).visible).toBe(
      false,
    )
  })

  it('appears once the live end is genuinely off screen', () => {
    const view = jumpToLatestView({
      pinned: false,
      distanceFromBottom: JUMP_VISIBLE_THRESHOLD_PX + 1,
      missed: 0,
    })
    expect(view.visible).toBe(true)
    expect(view.label).toBe('Jump to latest ↓')
  })

  it('does not flash for a few pixels of streaming jitter', () => {
    expect(
      jumpToLatestView({ pinned: false, distanceFromBottom: 20, missed: 3 }).visible,
    ).toBe(false)
  })

  it('says HOW MUCH was missed — the other half of the complaint', () => {
    const view = jumpToLatestView({ pinned: false, distanceFromBottom: 900, missed: 3 })
    expect(view.label).toBe('3 new ↓')
    expect(view.ariaLabel).toContain('3 new messages')
  })

  it('singularises', () => {
    expect(jumpToLatestView({ pinned: false, distanceFromBottom: 900, missed: 1 }).ariaLabel).toContain(
      '1 new message —',
    )
  })

  it('never announces a bare arrow to assistive tech', () => {
    const view = jumpToLatestView({ pinned: false, distanceFromBottom: 900, missed: 0 })
    expect(view.ariaLabel).toBe('Jump to the latest message')
  })

  it('ignores a nonsense missed count', () => {
    expect(jumpToLatestView({ pinned: false, distanceFromBottom: 900, missed: -4 }).label).toBe(
      'Jump to latest ↓',
    )
  })
})
