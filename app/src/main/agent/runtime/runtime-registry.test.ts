import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
} from './agent-runtime'
import {
  assertAdmissible,
  createRuntime,
  DEFAULT_PROVIDER,
  isKnownProvider,
  resolveProvider,
  selectRuntime,
} from './runtime-registry'

const SAFE_CAPS: RuntimeCapabilities = {
  driveHeadless: true,
  parseableStream: true,
  resumeHandle: true,
  containment: 'native',
  toolApproval: 'per-tool',
  toolEvents: true,
  subAgents: 'native',
  modelSelection: true,
}

function fakeRuntime(id: string, caps: RuntimeCapabilities = SAFE_CAPS): AgentRuntime {
  return {
    id,
    capabilities: caps,
    start: () => ({} as RuntimeSession),
  }
}

describe('resolveProvider — override ?? default ?? legacy', () => {
  it('uses the per-project override when present', () => {
    expect(resolveProvider({ projectProvider: 'codex', globalDefault: 'claude' })).toEqual({
      provider: 'codex',
      source: 'project-override',
    })
  })

  it('falls back to the global default when there is no project override', () => {
    expect(resolveProvider({ projectProvider: null, globalDefault: 'codex' })).toEqual({
      provider: 'codex',
      source: 'global-default',
    })
  })

  it('falls back to legacy claude when nothing is configured', () => {
    expect(resolveProvider({})).toEqual({ provider: DEFAULT_PROVIDER, source: 'legacy-default' })
    expect(DEFAULT_PROVIDER).toBe('claude')
  })

  it('treats an empty/whitespace value as absent (skips that level)', () => {
    expect(resolveProvider({ projectProvider: '  ', globalDefault: 'codex' }).provider).toBe('codex')
  })

  it('throws (fail-closed) on an unknown provider rather than coercing to claude', () => {
    expect(() => resolveProvider({ projectProvider: 'coddex' })).toThrow(/unknown provider 'coddex'/)
    expect(() => resolveProvider({ globalDefault: 'gpt' })).toThrow(/valid providers: claude, codex, copilot/)
  })
})

describe('isKnownProvider', () => {
  it('accepts the known set and rejects anything else', () => {
    expect(isKnownProvider('claude')).toBe(true)
    expect(isKnownProvider('codex')).toBe(true)
    expect(isKnownProvider('copilot')).toBe(true)
    expect(isKnownProvider('gpt')).toBe(false)
  })
})

describe('assertAdmissible — the safety floor', () => {
  it('admits a runtime with headless drive, parseable stream, and containment', () => {
    expect(() => assertAdmissible('claude', SAFE_CAPS)).not.toThrow()
    expect(() => assertAdmissible('codex', { ...SAFE_CAPS, containment: 'native' })).not.toThrow()
    expect(() => assertAdmissible('sandboxed', { ...SAFE_CAPS, containment: 'sandbox' })).not.toThrow()
  })

  it('REJECTS a runtime with no containment strategy — it never runs', () => {
    const uncontained = { ...SAFE_CAPS, containment: 'none' as unknown as RuntimeCapabilities['containment'] }
    expect(() => assertAdmissible('rogue', uncontained)).toThrow(/not admissible/)
    expect(() => assertAdmissible('rogue', uncontained)).toThrow(/no containment strategy/)
  })

  it('rejects a runtime that cannot be driven headless or parsed', () => {
    expect(() => assertAdmissible('x', { ...SAFE_CAPS, driveHeadless: false as true })).toThrow(
      /cannot be driven headless/,
    )
    expect(() => assertAdmissible('x', { ...SAFE_CAPS, parseableStream: false as true })).toThrow(
      /no parseable event stream/,
    )
  })
})

describe('createRuntime — build + admit', () => {
  it('constructs the configured provider and returns it once admitted', () => {
    const runtime = createRuntime('codex', { codex: () => fakeRuntime('codex') })
    expect(runtime.id).toBe('codex')
  })

  it('throws an actionable error when the provider has no configured thunk', () => {
    expect(() => createRuntime('copilot', { claude: () => fakeRuntime('claude') })).toThrow(
      /no 'copilot' runtime is configured/,
    )
  })

  it('refuses to hand back an inadmissible runtime even if its thunk exists', () => {
    const badCaps = { ...SAFE_CAPS, containment: 'none' as unknown as RuntimeCapabilities['containment'] }
    expect(() => createRuntime('codex', { codex: () => fakeRuntime('codex', badCaps) })).toThrow(
      /not admissible/,
    )
  })
})

describe('selectRuntime — config to admitted runtime, end to end', () => {
  it('resolves the provider from config and builds its admitted runtime', () => {
    const { runtime, resolved } = selectRuntime(
      { projectProvider: 'codex', globalDefault: 'claude' },
      { claude: () => fakeRuntime('claude'), codex: () => fakeRuntime('codex') },
    )
    expect(runtime.id).toBe('codex')
    expect(resolved).toEqual({ provider: 'codex', source: 'project-override' })
  })

  it('falls to legacy claude when nothing is configured', () => {
    const { runtime, resolved } = selectRuntime({}, { claude: () => fakeRuntime('claude') })
    expect(runtime.id).toBe('claude')
    expect(resolved.source).toBe('legacy-default')
  })
})
