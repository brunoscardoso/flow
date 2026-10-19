import { describeRuntimeFailure, isAuthFailure, isConfigFailure } from './runtime-failure'

describe('describeRuntimeFailure', () => {
  it('names a config failure for what it is, and keeps the tool’s words', () => {
    // Captured from a real turn: codex-cli 0.19.0 against a config.toml written
    // for a newer one. EVERY headless run dies this way, whatever the prompt.
    const raw =
      'Reading prompt from stdin... ERROR codex_core::config: Failed to deserialize overridden config: unknown variant `xhigh`, expected one of `low`, `medium`, `high`, `none` in `model_reasoning_effort`'
    const said = describeRuntimeFailure('Codex', raw)
    expect(said).toContain('could not read its own settings file')
    expect(said).toContain('older than something in that file')
    // The raw text still rides along — a transcript is where it belongs.
    expect(said).toContain('model_reasoning_effort')
  })

  it('passes an ordinary failure through under the runtime’s name', () => {
    expect(describeRuntimeFailure('Copilot', 'Error: Model "opus" is not available.')).toBe(
      'Copilot: Error: Model "opus" is not available.',
    )
  })

  it('recognises the shapes both CLIs actually print', () => {
    expect(isConfigFailure('Error loading configuration: unknown variant `xhigh`')).toBe(true)
    expect(isConfigFailure('Failed to deserialize overridden config')).toBe(true)
    expect(isConfigFailure('Error: Model "opus" is not available.')).toBe(false)
  })
})

describe('isAuthFailure', () => {
  it('recognises a refused credential in the runtime’s own words', () => {
    expect(isAuthFailure('stream error: Failed to refresh token: 401 Unauthorized; retrying 1/5')).toBe(true)
    expect(isAuthFailure('Error: invalid_api_key')).toBe(true)
    expect(isAuthFailure('Not logged in')).toBe(true)
  })

  it('does not mistake other failures for it', () => {
    expect(isAuthFailure('Error: Model "opus" is not available.')).toBe(false)
    expect(isAuthFailure('unknown variant `xhigh`')).toBe(false)
  })

  it('says what to do about it, before the tool’s words', () => {
    const said = describeRuntimeFailure('Codex', 'Failed to refresh token: 401 Unauthorized')
    expect(said).toContain('rejected the sign-in')
    expect(said).toContain('Sign in to Codex again')
    expect(said).toContain('401')
  })
})
