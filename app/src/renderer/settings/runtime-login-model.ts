// What the in-app runtime sign-in SHOWS, as a pure reduction of what happened.
// The widget only renders this — so the sentence a person reads while waiting
// for GitHub is testable without a browser, a shell, or an OAuth app.
//
// Every sentence here is FLOW'S. The first version relayed the tool's last
// printed line, which produced "Codex sign-in did not complete — in
// `model_reasoning_effort`": the second half of a config parse error, shown to
// somebody who pressed Sign in. A failure arrives classified; what the tool
// actually printed is in the log.

import type { RuntimeLoginFailure, RuntimeLoginProgress } from '../../shared/ipc-contract'
import { runtimeName } from './runtime-ready'

export interface RuntimeLoginState {
  /** The line at the top of the assist. */
  status: string
  /** The page to open, once the tool has printed one. */
  url: string | null
  /** The device code to type there, when the flow uses one. */
  code: string | null
  /** True once the flow ended — either way. */
  finished: boolean
  ok: boolean
}

export function initialRuntimeLoginState(provider: string): RuntimeLoginState {
  return {
    status: `Starting ${runtimeName(provider)} sign-in…`,
    url: null,
    code: null,
    finished: false,
    ok: false,
  }
}

/**
 * Why it stopped, said in terms of the runtime and what to do next.
 *
 * `config-unreadable` is the one that earns its own sentence: the tool never
 * reached the login at all — it could not read its own settings file — so
 * "sign-in failed" would send someone to re-authorise something that was never
 * the problem.
 */
export function failureMessage(provider: string, reason: RuntimeLoginFailure): string {
  const name = runtimeName(provider)
  switch (reason) {
    case 'config-unreadable':
      return `${name} could not read its own settings file, so the sign-in stopped before it began. Updating ${name} usually fixes this.`
    case 'not-installed':
      return `${name} is not installed, so there is nothing to sign in to.`
    case 'cancelled':
      return `${name} sign-in cancelled.`
    case 'timeout':
      return `The ${name} sign-in took too long and was stopped.`
    default:
      return `The ${name} sign-in did not complete.`
  }
}

/**
 * Fold one event into the state.
 *
 * A URL replaces the status line with an instruction the reader can act on,
 * and nothing after that is allowed to overwrite it — the tool prints
 * "Waiting for authorization..." one line later, and pushing the link off the
 * screen while somebody is still reading it helps nobody.
 */
export function reduceRuntimeLogin(
  state: RuntimeLoginState,
  event: RuntimeLoginProgress,
): RuntimeLoginState {
  const name = runtimeName(event.provider)
  switch (event.kind) {
    case 'url':
      return {
        ...state,
        url: event.url ?? state.url,
        status: 'Open the sign-in page, then come back — Flow is waiting.',
      }
    case 'code':
      return { ...state, code: event.code ?? state.code }
    case 'done':
      return { ...state, finished: true, ok: true, status: `Signed in to ${name}.` }
    case 'error':
      return {
        ...state,
        finished: true,
        ok: false,
        status: failureMessage(event.provider, event.reason ?? 'failed'),
      }
    default:
      return state
  }
}
