// login-assist-model tests (#972) — the pure event → view-state reducer.

import {
  INITIAL_LOGIN_ASSIST_STATE,
  reduceLoginEvent,
  type LoginAssistState,
} from './login-assist-model'

describe('reduceLoginEvent', () => {
  it('starts with no url and not awaiting a code', () => {
    expect(INITIAL_LOGIN_ASSIST_STATE).toEqual({ url: null, awaitingCode: false })
  })

  it('records the sign-in url from a url event', () => {
    const next = reduceLoginEvent(INITIAL_LOGIN_ASSIST_STATE, {
      phase: 'url',
      url: 'https://claude.com/oauth',
    })
    expect(next).toEqual({ url: 'https://claude.com/oauth', awaitingCode: false })
  })

  it('keeps the FIRST url on a repeated url event and returns the same state', () => {
    const withUrl: LoginAssistState = { url: 'https://first.example', awaitingCode: false }
    const next = reduceLoginEvent(withUrl, { phase: 'url', url: 'https://second.example' })
    expect(next).toBe(withUrl)
  })

  it('flips awaitingCode on the paste-code prompt, preserving the url', () => {
    const withUrl: LoginAssistState = { url: 'https://claude.com/oauth', awaitingCode: false }
    const next = reduceLoginEvent(withUrl, { phase: 'awaiting-code' })
    expect(next).toEqual({ url: 'https://claude.com/oauth', awaitingCode: true })
  })

  it('tolerates awaiting-code arriving before any url', () => {
    const next = reduceLoginEvent(INITIAL_LOGIN_ASSIST_STATE, { phase: 'awaiting-code' })
    expect(next).toEqual({ url: null, awaitingCode: true })
  })

  it('returns the same state for a repeated awaiting-code event', () => {
    const awaiting: LoginAssistState = { url: null, awaitingCode: true }
    expect(reduceLoginEvent(awaiting, { phase: 'awaiting-code' })).toBe(awaiting)
  })
})
