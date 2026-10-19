// Pure view-state reducer for the interactive-login assist (#972) — DOM-free
// so it stays unit-testable under the app's node-env jest.

import type { IpcEventPayload } from '../../shared/ipc-contract'

export type AccountLoginEvent = IpcEventPayload<'accounts:loginEvent'>

/** What the assist should be showing right now. */
export interface LoginAssistState {
  /** The "If the browser didn't open, visit:" fallback URL — null until seen. */
  url: string | null
  /** True once the CLI is blocking on its paste-the-code prompt. */
  awaitingCode: boolean
}

export const INITIAL_LOGIN_ASSIST_STATE: LoginAssistState = {
  url: null,
  awaitingCode: false,
}

/** Fold one login event into the view state (events are each-at-most-once,
 *  but the reducer tolerates repeats and out-of-order delivery). Returns the
 *  SAME state object when nothing changed, so callers can skip re-rendering. */
export function reduceLoginEvent(
  state: LoginAssistState,
  event: AccountLoginEvent,
): LoginAssistState {
  if (event.phase === 'url') {
    if (state.url !== null) return state
    return { ...state, url: event.url }
  }
  if (state.awaitingCode) return state
  return { ...state, awaitingCode: true }
}
