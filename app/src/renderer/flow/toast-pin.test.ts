import { PIN_BOTTOM_SLACK_PX, shouldPinToNewest } from './toast-pin'

// #1458 — #1036's pin ("scroll to the newest arrival") had no exemption for the
// one card that carries the only in-app way to unblock a task. A burst of
// routine chatter scrolled the reply box out of the window while it kept focus
// and kept swallowing keystrokes.

const atBottom = { scrollHeight: 900, scrollTop: 600, clientHeight: 300 }

describe('shouldPinToNewest (#1458)', () => {
  it('pins for the ordinary toast — no focus, stack at the bottom', () => {
    expect(shouldPinToNewest({ ...atBottom, holdsFocus: false })).toBe(true)
  })

  it('pins when the stack is too short to scroll at all', () => {
    // The common case by far: one or two cards, nothing to scroll.
    expect(
      shouldPinToNewest({ scrollHeight: 200, scrollTop: 0, clientHeight: 400, holdsFocus: false }),
    ).toBe(true)
  })

  it('never pins while focus is inside the stack — that is the reply box', () => {
    expect(shouldPinToNewest({ ...atBottom, holdsFocus: true })).toBe(false)
  })

  it('does not pin when the user has scrolled away from the bottom', () => {
    // They chose what to look at; a new informational toast must not undo it.
    expect(
      shouldPinToNewest({ scrollHeight: 900, scrollTop: 100, clientHeight: 300, holdsFocus: false }),
    ).toBe(false)
  })

  it('still pins within the fractional-pixel slack', () => {
    // Zoom / device pixel ratios leave scrollTop a hair short of the bottom;
    // that must not read as a deliberate scroll.
    expect(
      shouldPinToNewest({
        scrollHeight: 900,
        scrollTop: 600 - PIN_BOTTOM_SLACK_PX,
        clientHeight: 300,
        holdsFocus: false,
      }),
    ).toBe(true)
    expect(
      shouldPinToNewest({
        scrollHeight: 900,
        scrollTop: 600 - PIN_BOTTOM_SLACK_PX - 1,
        clientHeight: 300,
        holdsFocus: false,
      }),
    ).toBe(false)
  })

  it('treats focus as decisive even mid-scroll', () => {
    expect(
      shouldPinToNewest({ scrollHeight: 900, scrollTop: 0, clientHeight: 300, holdsFocus: true }),
    ).toBe(false)
  })
})
