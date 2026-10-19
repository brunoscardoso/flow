import {
  parseCollapseMode,
  threadsCollapseView,
  type ThreadsCollapseMode,
} from './threads-collapse'

// #1219: "collapse and hide the threads, same as we have on source control.
// both options, only list of threads or the chat thread and list."
//
// …and the correction of 2026-08-24, off a screenshot of the toolbar row
// (checklist · + · ⌄ · —): "don't make sense minimize this like that". The
// list-only caret is gone, and `list-collapsed` with it.

describe('threadsCollapseView (#1219)', () => {
  it('offers the one put-away state that is left', () => {
    // "the chat thread and list" — both go, together.
    expect(threadsCollapseView('all-hidden')).toMatchObject({
      listVisible: false,
      chatVisible: false,
    })
  })

  it('shows everything by default', () => {
    expect(threadsCollapseView('expanded')).toMatchObject({
      listVisible: true,
      chatVisible: true,
    })
  })

  it('names the way back from the fully-hidden state', () => {
    // A blank panel the user has to guess their way out of is the failure mode
    // every collapse affordance in this app is written against — and it is the
    // WHOLE way back now: the `—` is drawn on the chat, so this state is
    // exactly the one in which that control is not on screen.
    expect(threadsCollapseView('all-hidden').restoreHint).toBe('Threads and chat hidden')
    expect(threadsCollapseView('expanded').restoreHint).toBeNull()
  })

  it('never hides the list on its own — the state the caret owned is gone', () => {
    // The list is only ever put away together with the chat. A list hidden
    // while the chat is up is the state whose only exit was a chevron inside
    // the strip it had just emptied.
    const modes: ThreadsCollapseMode[] = ['expanded', 'all-hidden']
    for (const mode of modes) {
      const view = threadsCollapseView(mode)
      expect(view.listVisible).toBe(view.chatVisible)
    }
  })
})


describe('parseCollapseMode (#1219)', () => {
  it('round-trips the real modes', () => {
    const modes: ThreadsCollapseMode[] = ['expanded', 'all-hidden']
    for (const mode of modes) expect(parseCollapseMode(mode)).toBe(mode)
  })

  it('brings a persisted list-collapsed back as expanded', () => {
    // THE MIGRATION. Every build with the chevron persisted this value, and
    // its control no longer exists — restoring it verbatim would boot those
    // users into a hidden list with nothing on screen to bring it back.
    expect(parseCollapseMode('list-collapsed')).toBe('expanded')
  })

  it('never boots into a hidden panel on junk', () => {
    // A corrupt localStorage value must not leave the user staring at nothing.
    expect(parseCollapseMode(null)).toBe('expanded')
    expect(parseCollapseMode('')).toBe('expanded')
    expect(parseCollapseMode('{"nope":1}')).toBe('expanded')
  })
})

describe('search over a hidden list (#1325)', () => {
  // The search box lives in the TOOLBAR, which `all-hidden` leaves on screen,
  // above a list it has hidden. Typing there still changes nothing visible —
  // matches render into the hidden wrapper. #1219 introduced this with two
  // put-away modes; one of them is now gone, and this is what is left of it.
  // Unfixed on purpose: the restore hint sits directly under the box saying
  // what state the panel is in, and reaching further is another change.
  it('still leaves the list hidden while the box is typeable', () => {
    expect(threadsCollapseView('all-hidden').listVisible).toBe(false)
  })
})
