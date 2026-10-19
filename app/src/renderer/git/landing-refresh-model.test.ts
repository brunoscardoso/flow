// When the landing bar looks again (thread-worktrees Phase 9).
//
// THE REGRESSION THESE GUARD. The bar read its preview once — at the instant
// the thread's checkout was created, when the checkout is a pristine copy and
// the honest answer is "nothing has changed yet". Everything the thread then
// wrote was invisible to it, so Merge stayed disabled with that stale reason
// for the whole life of the thread.
//
// And the OTHER half, which is why these are rules rather than a subscription:
// answering a hot broadcast with a full refresh is a bug this repo has fixed
// five times (allowed-pattern #17). A batch that names no thread the bar is
// bound to must buy nothing, and neither must a panel nobody can see.

import type { ThreadChangeEvent } from '../../shared/ipc-contract'
import { landingRefreshOnThreadEvents, landingRefreshOnVisibility } from './landing-refresh-model'

const BOUND = 'thread-bound'
const OTHER = 'thread-other'

const event = (
  entity: ThreadChangeEvent['entity'],
  threadId: string,
  action: ThreadChangeEvent['action'] = 'updated',
): ThreadChangeEvent => ({ entity, action, threadId })

describe('landingRefreshOnThreadEvents', () => {
  const onScreen = { boundThreadId: BOUND, panelOnScreen: true }

  it('looks again when the bound thread’s own turn moves', () => {
    expect(landingRefreshOnThreadEvents({ events: [event('thread', BOUND)], ...onScreen })).toBe(
      'refresh',
    )
  })

  it('looks again for a batch that merely CONTAINS the bound thread', () => {
    const events = [event('tool_call', BOUND), event('message', OTHER), event('thread', BOUND)]
    expect(landingRefreshOnThreadEvents({ events, ...onScreen })).toBe('refresh')
  })

  // The streaming turn's bulk: two tool_call events per call, one message per
  // assistant message, every 50ms. None of it moves what the bar reads — the
  // bar reads git in a checkout, not the thread's rows.
  it('buys nothing for pure tool-call and message churn', () => {
    const events = [event('tool_call', BOUND), event('message', BOUND, 'created')]
    expect(landingRefreshOnThreadEvents({ events, ...onScreen })).toBe('skip')
  })

  it('buys nothing for another thread’s turn', () => {
    expect(landingRefreshOnThreadEvents({ events: [event('thread', OTHER)], ...onScreen })).toBe(
      'skip',
    )
  })

  it('buys nothing while the panel is off screen — the reveal re-reads anyway', () => {
    expect(
      landingRefreshOnThreadEvents({
        events: [event('thread', BOUND)],
        boundThreadId: BOUND,
        panelOnScreen: false,
      }),
    ).toBe('skip')
  })

  it('buys nothing when the bar is bound to no thread', () => {
    expect(
      landingRefreshOnThreadEvents({
        events: [event('thread', BOUND)],
        boundThreadId: null,
        panelOnScreen: true,
      }),
    ).toBe('skip')
  })

  it('buys nothing for an empty batch', () => {
    expect(landingRefreshOnThreadEvents({ events: [], ...onScreen })).toBe('skip')
  })
})

describe('landingRefreshOnVisibility', () => {
  it('looks again when the panel comes into view', () => {
    expect(
      landingRefreshOnVisibility({ wasOnScreen: false, nowOnScreen: true, boundThreadId: BOUND }),
    ).toBe('refresh')
  })

  it('buys nothing when the panel was already in view', () => {
    expect(
      landingRefreshOnVisibility({ wasOnScreen: true, nowOnScreen: true, boundThreadId: BOUND }),
    ).toBe('skip')
  })

  it('buys nothing when the panel goes away', () => {
    expect(
      landingRefreshOnVisibility({ wasOnScreen: true, nowOnScreen: false, boundThreadId: BOUND }),
    ).toBe('skip')
  })

  it('buys nothing when the bar is bound to no thread', () => {
    expect(
      landingRefreshOnVisibility({ wasOnScreen: false, nowOnScreen: true, boundThreadId: null }),
    ).toBe('skip')
  })
})
