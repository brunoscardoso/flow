import {
  AUTO_MODEL,
  isModelFor,
  modelForRuntime,
  modelOptionsFor,
  supportsModelRouting,
} from './runtime-models'

describe('modelOptionsFor', () => {
  it('offers the Claude aliases for Claude', () => {
    expect(modelOptionsFor('claude').map((o) => o.value)).toEqual([
      'auto',
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ])
  })

  it('offers only Auto for the runtimes that pick their own', () => {
    // Measured: `copilot --model claude-sonnet-4.5` and `--model gpt-5` are
    // both "not available" on a signed-in account; `auto` works. The set is
    // account-specific and there is no headless way to list it, so a menu of
    // names would be a menu of failures.
    for (const provider of ['codex', 'copilot']) {
      expect(modelOptionsFor(provider).map((o) => o.value)).toEqual([AUTO_MODEL])
    }
  })
})

describe('modelForRuntime — what actually reaches the CLI', () => {
  it('NEVER hands an Anthropic alias to another runtime', () => {
    // The live failure: "Error: Model "opus" from --model flag is not
    // available." — and a chat that did nothing at all.
    expect(modelForRuntime('copilot', 'opus')).toBeUndefined()
    expect(modelForRuntime('codex', 'sonnet')).toBeUndefined()
  })

  it('passes a Claude model through for Claude', () => {
    expect(modelForRuntime('claude', 'opus')).toBe('opus')
  })

  it('treats Auto and empty as "your default", for everyone', () => {
    expect(modelForRuntime('claude', AUTO_MODEL)).toBeUndefined()
    expect(modelForRuntime('copilot', AUTO_MODEL)).toBeUndefined()
    expect(modelForRuntime('copilot', null)).toBeUndefined()
    expect(modelForRuntime('copilot', '')).toBeUndefined()
  })

  it('drops a foreign model for Claude, whose list IS known', () => {
    expect(modelForRuntime('claude', 'gpt-5')).toBeUndefined()
  })

  it('passes the user’s own id through for a runtime with no listable models', () => {
    // Settings → Models is where these come from: Codex reported it was running
    // gpt-5-mini and offered no way to change it, because neither CLI can list
    // what an account has. Flow cannot validate the id — but it can refuse to
    // invent one, and it can refuse to send Anthropic's.
    expect(modelForRuntime('codex', 'gpt-5.1-codex-max')).toBe('gpt-5.1-codex-max')
    expect(modelForRuntime('copilot', 'claude-sonnet-4.5')).toBe('claude-sonnet-4.5')
    expect(modelForRuntime('codex', 'opus')).toBeUndefined()
  })
})

describe('isModelFor / supportsModelRouting', () => {
  it('knows whose model is whose', () => {
    expect(isModelFor('claude', 'haiku')).toBe(true)
    expect(isModelFor('copilot', 'haiku')).toBe(false)
    expect(isModelFor('copilot', 'auto')).toBe(true)
  })

  it('routes effort to models for Claude only', () => {
    expect(supportsModelRouting('claude')).toBe(true)
    expect(supportsModelRouting('codex')).toBe(false)
    expect(supportsModelRouting('copilot')).toBe(false)
  })
})

describe('a pin from another runtime never reaches Claude', () => {
  it('drops a Codex model on the Claude path', () => {
    // Reported live: switching back to Anthropic and opening a NEW chat still
    // ran gpt-5.1-codex-max — "There's an issue with the selected model
    // (gpt-5.1-codex-max). It may not exist or you may not have access to it."
    expect(modelForRuntime('claude', 'gpt-5.1-codex-max')).toBeUndefined()
    // …which means the turn routes by effort, exactly as Auto does.
  })
})

describe('fable is offered, because the runtime accepts it', () => {
  // THE EVIDENCE, not an assumption. `claude --help` documents the aliases:
  //   --model <model>  Provide an alias for the latest model (e.g. 'fable',
  //                    'opus', or 'sonnet') or a model's full name.
  // It was missing from the picker while the CLI had accepted it all along, so
  // an account with Fable available was shown three models out of four.

  it('appears in the Claude picker, newest first', () => {
    expect(modelOptionsFor('claude').map((option) => option.value)).toEqual([
      'auto',
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ])
  })

  it('reaches the runtime instead of being dropped', () => {
    // The teeth of the old list: an unknown model was silently replaced by
    // "your default", so a thread pinned to it ran on something else entirely.
    expect(modelForRuntime('claude', 'fable')).toBe('fable')
    expect(isModelFor('claude', 'fable')).toBe(true)
  })

  it('still never reaches a runtime it does not belong to', () => {
    // The bug this module was written for: an Anthropic alias handed to another
    // CLI is a turn that does nothing. Widening Claude's list must not widen
    // that, and Codex's picker is unchanged.
    expect(modelForRuntime('codex', 'fable')).toBeUndefined()
    expect(modelForRuntime('copilot', 'fable')).toBeUndefined()
    expect(modelOptionsFor('codex').map((option) => option.value)).toEqual(['auto'])
  })
})

describe('an alias is not an id, and Copilot depends on the difference', () => {
  it('still sends Copilot the Anthropic models it can actually run', () => {
    // A regression caught here, not in review: once `isModelFor` learned to
    // accept full Anthropic ids (so a discovered `claude-opus-5` could be
    // pinned on Claude), the cross-runtime guard started reading those ids as
    // "Anthropic's, drop it" — and quietly stopped sending Copilot the models
    // on its own measured candidate list.
    expect(modelForRuntime('copilot', 'claude-sonnet-4.5')).toBe('claude-sonnet-4.5')
    expect(modelForRuntime('copilot', 'claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(modelForRuntime('copilot', 'claude-haiku-4.5')).toBe('claude-haiku-4.5')
  })

  it('still refuses a bare alias, which is what actually fails there', () => {
    // Measured: `copilot --model opus` → 'Model "opus" … is not available.'
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      expect(modelForRuntime('copilot', alias)).toBeUndefined()
      expect(modelForRuntime('codex', alias)).toBeUndefined()
    }
  })

  it('accepts a discovered id on the Claude path', () => {
    // The other half: ids read from the account's own catalogue must reach the
    // CLI, which documents "an alias … or a model's full name".
    expect(modelForRuntime('claude', 'claude-opus-5')).toBe('claude-opus-5')
    expect(modelForRuntime('claude', 'claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]')
    expect(modelForRuntime('claude', 'gpt-5')).toBeUndefined()
    expect(modelForRuntime('claude', 'cc-update-required-1')).toBeUndefined()
  })
})
