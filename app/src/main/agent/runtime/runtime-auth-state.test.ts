import {
  clearRuntimeAuthFailure,
  markRuntimeAuthFailure,
  resetRuntimeAuthFailures,
  runtimeAuthFailedAt,
} from './runtime-auth-state'

beforeEach(() => resetRuntimeAuthFailures())

describe('runtime auth refusals', () => {
  it('remembers a refusal per runtime', () => {
    markRuntimeAuthFailure('codex', 1_000)
    expect(runtimeAuthFailedAt('codex')).toBe(1_000)
    // One runtime's expired token says nothing about another's.
    expect(runtimeAuthFailedAt('copilot')).toBeNull()
  })

  it('is spent by anything that works', () => {
    markRuntimeAuthFailure('codex', 1_000)
    clearRuntimeAuthFailure('codex')
    expect(runtimeAuthFailedAt('codex')).toBeNull()
  })

  it('starts empty — the file is the durable truth, this is one observation', () => {
    expect(runtimeAuthFailedAt('codex')).toBeNull()
  })
})
