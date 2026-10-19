import {
  decideDiscoveryAction,
  discoveryFoundNothingNotice,
  matchDiscoveryEvent,
  type DiscoveryActionInput,
} from './empty-actions'

const discovery = (over: Partial<DiscoveryActionInput> = {}): DiscoveryActionInput => ({
  place: 'root',
  rootPath: '/repo',
  provisioning: 'ready',
  fetchFailed: false,
  running: false,
  ...over,
})

describe('decideDiscoveryAction — the empty board offers the gesture, not a route to Settings', () => {
  it('offers a pressable button on a ready root with an empty store', () => {
    const action = decideDiscoveryAction(discovery())
    expect(action).not.toBeNull()
    expect(action?.label).toBe('Run basic discovery')
    expect(action?.disabled).toBe(false)
    expect(action?.running).toBe(false)
  })

  it('never names Settings or a CLI verb — the button IS the instruction', () => {
    const action = decideDiscoveryAction(discovery())
    const text = `${action?.label ?? ''} ${action?.title ?? ''}`
    expect(text).not.toMatch(/Settings/)
    expect(text).not.toMatch(/planflow-ai|features discover|npx/)
  })

  it('says how long it takes and that the board refreshes itself', () => {
    expect(decideDiscoveryAction(discovery())?.title).toMatch(/minutes/)
    expect(decideDiscoveryAction(discovery({ running: true }))?.title).toMatch(/by itself/)
  })

  // DEFECT A. `runFeatures` reports a timeout, a missing CLI and unparseable
  // output all as `available: false` — a failed READ, not an empty store.
  it('shows NO discovery button when the feature query failed', () => {
    expect(decideDiscoveryAction(discovery({ fetchFailed: true }))).toBeNull()
    // …not even while one is somehow in flight.
    expect(decideDiscoveryAction(discovery({ fetchFailed: true, running: true }))).toBeNull()
  })

  // DEFECT B. `enqueueBasicDiscovery` returns early — silently — when the root
  // is not ready, so a pressable control there is a guaranteed no-op.
  it.each([
    ['provisioning' as const, /still setting this project up/i],
    ['failed' as const, /failed/i],
    ['idle' as const, /not set up for plan-flow yet/i],
    [undefined, /not set up for plan-flow yet/i],
  ])('disables the button with a reason while the root is %s', (state, matcher) => {
    const action = decideDiscoveryAction(discovery({ provisioning: state }))
    expect(action).not.toBeNull()
    expect(action?.disabled).toBe(true)
    expect(action?.title).toMatch(matcher)
  })

  it('shows a running state that cannot be pressed twice', () => {
    const action = decideDiscoveryAction(discovery({ running: true }))
    expect(action?.running).toBe(true)
    expect(action?.disabled).toBe(true)
    expect(action?.label).toBe('Finding features…')
  })

  it('offers nothing without a project, and nothing below the root', () => {
    expect(decideDiscoveryAction(discovery({ rootPath: null }))).toBeNull()
    expect(decideDiscoveryAction(discovery({ rootPath: '   ' }))).toBeNull()
    expect(decideDiscoveryAction(discovery({ place: 'feature' }))).toBeNull()
    expect(decideDiscoveryAction(discovery({ place: 'part' }))).toBeNull()
  })

  // A DOMAIN CANNOT BE FIXED BY A MACHINE — `domain:` is human-owned.
  // (The other half of this rule — that the one slow gesture is not offered
  // for a domain either — lives in `understand-action.test.ts`.)
  it('offers no action for a domain, ever', () => {
    expect(decideDiscoveryAction(discovery({ place: 'domain' }))).toBeNull()
  })

  it('keeps the last failure beside the action, trimmed', () => {
    expect(decideDiscoveryAction(discovery({ error: '  spawn ENOENT  ' }))?.error).toBe(
      'spawn ENOENT',
    )
    expect(decideDiscoveryAction(discovery({ error: '   ' }))?.error).toBeNull()
    // Never beside a RUNNING one — the old failure is no longer the news.
    expect(decideDiscoveryAction(discovery({ running: true, error: 'boom' }))?.error).toBeNull()
  })
})

describe('matchDiscoveryEvent — the terminal signal for a running discovery', () => {
  it('lands only for the project that started it', () => {
    expect(matchDiscoveryEvent({ rootId: '/other', added: 3 }, '/repo')).toBeNull()
    expect(matchDiscoveryEvent({ rootId: '/repo', added: 3 }, null)).toBeNull()
    expect(matchDiscoveryEvent({ rootId: '/repo', added: 3 }, '/repo')).toEqual({
      done: true,
      added: 3,
    })
  })

  it('reads a reason as the failing outcome', () => {
    expect(matchDiscoveryEvent({ rootId: '/repo', added: 0, reason: 'CLI refused' }, '/repo')).toEqual(
      { done: false, reason: 'CLI refused' },
    )
  })

  it('treats a missing/garbage count as zero rather than guessing', () => {
    expect(matchDiscoveryEvent({ rootId: '/repo' }, '/repo')).toEqual({ done: true, added: 0 })
    expect(matchDiscoveryEvent({ rootId: '/repo', added: -4 }, '/repo')).toEqual({
      done: true,
      added: 0,
    })
  })

  it('has words for "it ran and there was genuinely nothing"', () => {
    expect(discoveryFoundNothingNotice()).toMatch(/found no capability/)
  })
})
