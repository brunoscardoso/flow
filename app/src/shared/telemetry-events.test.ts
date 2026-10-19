import { ERROR_KINDS, usageEvent, type EventShapes } from './telemetry-events'
import {
  EVENT_FIELDS,
  EVENT_NAMES,
  INSTALL_FIELDS,
  refusalsFor,
  type EventName,
} from './telemetry-allowlist'

/**
 * ONE FULLY-POPULATED EXAMPLE OF EVERY EVENT.
 *
 * Written out rather than generated, because a generated example can only
 * contain fields the generator already knew about — which is the same blind
 * spot as the thing under test. Typed as `EventShapes[K]`, so this table is
 * itself checked by the compiler: an event added to the union with no entry
 * here does not compile, and an entry with a stray property does not either.
 */
const EXAMPLES: { [K in EventName]: EventShapes[K] } = {
  'session.started': { at: 1, sessionId: 's' },
  'session.ended': { at: 2, durationMs: 1, sessionId: 's' },
  'thread.created': { at: 3, provider: 'claude', model: 'opus', threadCount: 4 },
  'debug.session.finished': { at: 4, durationMs: 10, count: 120 },
  'worktree.created': { at: 5, projectCount: 2 },
  'app.failed': { at: 6, errorKind: 'db-write', count: 1 },
}

describe('the event vocabulary', () => {
  it('has a shape for every name, and a name for every shape', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual([...EVENT_NAMES].sort())
  })

  // THE GUARD AGAINST THE HELPFUL EXTRA FIELD. Walks every event and offers its
  // fullest form to the same validator the door uses — so a property added to a
  // shape without being added to the allowlist fails here rather than on a
  // client's machine.
  it.each([...EVENT_NAMES])('%s carries only allowlisted fields', (name) => {
    const built = usageEvent(name, EXAMPLES[name] as never)
    expect(refusalsFor(built)).toEqual([])
  })

  it.each([...EVENT_NAMES])('%s names itself', (name) => {
    expect(usageEvent(name, EXAMPLES[name] as never).event).toBe(name)
  })

  it('does not let a caller name one event and shape it as another', () => {
    // `event` comes from the first argument, never from the props — so the two
    // cannot disagree even if a call site tries.
    const built = usageEvent('session.started', { at: 1, sessionId: 's' })
    expect(built.event).toBe('session.started')
  })

  it('draws every property from the fields the contract permits', () => {
    const permitted = new Set<string>([...EVENT_FIELDS, ...INSTALL_FIELDS])
    const strays: string[] = []
    for (const [name, props] of Object.entries(EXAMPLES)) {
      for (const key of Object.keys(props)) {
        if (!permitted.has(key)) strays.push(`${name}.${key}`)
      }
    }
    expect(strays).toEqual([])
  })
})

describe('errorKind', () => {
  it('is a vocabulary the app owns, not a word from an error', () => {
    // Every kind is a short slug naming an AREA. Anything with a space, a path
    // separator or capitals is a message that slipped in wearing a kind's coat.
    for (const kind of ERROR_KINDS) {
      expect(kind).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
    }
  })

  it('has somewhere to put a failure nobody classified', () => {
    // Without this, the first unclassified failure is a reason to pass the raw
    // error through "just this once".
    expect(ERROR_KINDS).toContain('unknown')
  })
})
