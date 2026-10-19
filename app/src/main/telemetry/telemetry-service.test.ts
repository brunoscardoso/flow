import { createTelemetryService, readMachineFacts } from './telemetry-service'
import { telemetryInstallId } from './install-facts'
import { EVENT_NAMES, refusalsFor } from '../../shared/telemetry-allowlist'

const ROOT = 'flow-ide-3f2a9c1b7e04'

/** The fullest form of every event, so none is untested by omission. */
const EVERY_EVENT = {
  'session.started': { at: 1, sessionId: 'session-1' },
  'session.ended': { at: 2, durationMs: 1000, sessionId: 'session-1' },
  'thread.created': { at: 3, provider: 'claude', model: 'opus', threadCount: 12 },
  'debug.session.finished': { at: 4, durationMs: 9000, count: 3720 },
  'worktree.created': { at: 5, projectCount: 3 },
  'app.failed': { at: 6, errorKind: 'db-write' as const, count: 1 },
}

const FACTS = {
  appVersion: '0.1.10',
  platform: 'darwin',
  osVersion: '25.6.0',
  arch: 'arm64',
  locale: 'en-GB',
  timezone: 'America/Sao_Paulo',
}

function harness(consent: boolean | null, clock = { t: 1000 }) {
  const sent: Record<string, unknown>[] = []
  let n = 0
  const service = createTelemetryService({
    rootInstallId: () => ROOT,
    firstRunAt: () => '2026-09-01T10:00:00.000Z',
    consent: () => consent,
    facts: () => FACTS,
    newSessionId: () => `session-${++n}`,
    now: () => clock.t,
    transport: (payload) => sent.push(payload),
  })
  return { service, sent, clock }
}

describe('the install report', () => {
  it('reports the installation and opens a session', () => {
    const h = harness(true)
    h.service.start()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.['installId']).toBe(telemetryInstallId(ROOT))
    expect(h.sent[0]?.['firstRunAt']).toBe('2026-09-01T10:00:00.000Z')
    expect(h.sent[1]?.['event']).toBe('session.started')
  })

  it('never puts the coordination id on the wire', () => {
    const h = harness(true)
    h.service.start()
    h.service.end()
    expect(JSON.stringify(h.sent)).not.toContain(ROOT)
    expect(JSON.stringify(h.sent)).not.toContain('flow-ide')
  })

  it('sends payloads the door accepts', () => {
    const h = harness(true)
    h.service.start()
    h.service.end()
    for (const payload of h.sent) expect(refusalsFor(payload)).toEqual([])
  })
})

describe('the join', () => {
  function withIdentity(identity: string | null) {
    const sent: Record<string, unknown>[] = []
    const service = createTelemetryService({
      rootInstallId: () => ROOT,
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      identityId: () => identity,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: (payload) => sent.push(payload),
    })
    service.start()
    return sent
  }

  it('carries the signed-in person when there is one', () => {
    expect(withIdentity('auth0|abc')[0]?.['identityId']).toBe('auth0|abc')
  })

  // ABSENT, NOT EMPTY. "Nobody has signed in" and "signed in as nothing" are
  // different facts, and a receiving end that sees '' cannot tell them apart.
  it('omits it entirely when nobody has signed in', () => {
    const payload = withIdentity(null)[0] ?? {}
    expect('identityId' in payload).toBe(false)
  })

  it('omits it when no identity source was wired at all', () => {
    const sent: Record<string, unknown>[] = []
    const service = createTelemetryService({
      rootInstallId: () => ROOT,
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: (payload) => sent.push(payload),
    })
    service.start()
    expect('identityId' in (sent[0] ?? {})).toBe(false)
  })

  // READ AT SEND TIME, like consent. Signing in must take effect on the next
  // report, not on the next restart — the same promise the switch makes.
  it('follows a sign-in that happened after the service was built', () => {
    let who: string | null = null
    const sent: Record<string, unknown>[] = []
    const service = createTelemetryService({
      rootInstallId: () => ROOT,
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      identityId: () => who,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: (payload) => sent.push(payload),
    })
    service.start()
    expect('identityId' in (sent[0] ?? {})).toBe(false)
    who = 'auth0|abc'
    service.start()
    expect(sent[sent.length - 2]?.['identityId'] ?? sent[sent.length - 1]?.['identityId']).toBe(
      'auth0|abc',
    )
  })

  // The identity is a NAME, never the proof of it.
  it('never carries a token, whatever the identity source returns', () => {
    const wire = JSON.stringify(withIdentity('auth0|abc'))
    expect(wire).not.toContain('live-session-token')
    expect(wire).not.toMatch(/token/i)
  })
})

describe('every event is attributable', () => {
  // THE TEST THAT WAS MISSING. The whole suite passed while `thread.created`
  // went out carrying nothing but `{ event, at }` — no installation, no
  // session — which made "how many installations use this" unanswerable from
  // the data being collected, and left the server's per-install rate limit
  // counting nothing. It was found by reading rows in a real database, not
  // here, because nothing here asked the question.
  function recorded() {
    const sent: Record<string, unknown>[] = []
    const service = createTelemetryService({
      rootInstallId: () => ROOT,
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: (payload) => sent.push(payload),
    })
    service.start()
    for (const name of EVENT_NAMES) service.record(name, EVERY_EVENT[name] as never)
    service.end()
    return sent
  }

  it.each([...EVENT_NAMES])('%s carries an installation', (name) => {
    const row = recorded().find((p) => p['event'] === name)
    expect(row?.['installId']).toBe(telemetryInstallId(ROOT))
  })

  it.each([...EVENT_NAMES])('%s carries the run it happened in', (name) => {
    const row = recorded().find((p) => p['event'] === name)
    expect(row?.['sessionId']).toBe('session-1')
  })

  it('still sends the DERIVED id, never the coordination one', () => {
    expect(JSON.stringify(recorded())).not.toContain(ROOT)
  })

  it('reads the store once, not once per event', () => {
    // `rootInstallId` hits the database; an event is not a reason to.
    let reads = 0
    const service = createTelemetryService({
      rootInstallId: () => {
        reads += 1
        return ROOT
      },
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: () => {},
    })
    service.start()
    for (let i = 0; i < 10; i += 1) service.record('worktree.created', { at: i })
    // One read for the install report, and the memo serves every event after.
    expect(reads).toBe(1)
  })
})

describe('the consent gate', () => {
  // POSITIVE BEFORE ABSENCE (allowed-pattern #28): the same calls DO send when
  // consent is true, proved above, so these absences mean the gate rather than
  // a service that never ran.
  it('sends nothing when the answer was no', () => {
    const h = harness(false)
    h.service.start()
    h.service.end()
    expect(h.sent).toEqual([])
  })

  it('does not even BUILD a payload when the answer was no', () => {
    // The door promises that with the switch off nothing is inspected and
    // nothing is built. An argument is evaluated before the call it is passed
    // to, so a service that composed the payload first would read the store and
    // the machine on every launch for somebody who declined — the door would
    // still refuse it, and the promise would still be false.
    let reads = 0
    const service = createTelemetryService({
      rootInstallId: () => {
        reads += 1
        return ROOT
      },
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => false,
      facts: () => {
        reads += 1
        return FACTS
      },
      newSessionId: () => 'session-1',
      transport: () => {},
    })
    service.start()
    expect(reads).toBe(0)
  })

  it('stamps the first run even when the answer was no', () => {
    // So that somebody who declines today and agrees next year reports the date
    // they INSTALLED Flow, not the date they changed their mind.
    let stamped = 0
    const service = createTelemetryService({
      rootInstallId: () => ROOT,
      firstRunAt: () => {
        stamped += 1
        return '2026-09-01T10:00:00.000Z'
      },
      consent: () => false,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: () => {},
    })
    service.start()
    expect(stamped).toBe(1)
  })

  it('sends nothing when nobody has been asked', () => {
    // `null` is not a yes. This is the state every existing installation is in
    // the moment this ships, so it is the one that has to be right.
    const h = harness(null)
    h.service.start()
    h.service.end()
    expect(h.sent).toEqual([])
  })
})

describe('the session boundary', () => {
  it('closes the session with how long it ran', () => {
    const clock = { t: 1000 }
    const h = harness(true, clock)
    h.service.start()
    clock.t = 61_000
    h.service.end()
    const last = h.sent[h.sent.length - 1]
    expect(last?.['event']).toBe('session.ended')
    expect(last?.['durationMs']).toBe(60_000)
  })

  it('carries one session id across both ends of the run', () => {
    const h = harness(true)
    h.service.start()
    h.service.end()
    const ids = new Set(h.sent.map((p) => p['sessionId']))
    expect(ids.size).toBe(1)
  })

  it('says nothing about a session that never started', () => {
    const h = harness(true)
    h.service.end()
    expect(h.sent).toEqual([])
  })
})

describe('failing silent', () => {
  it('does not let a broken store reach startup', () => {
    const service = createTelemetryService({
      rootInstallId: () => {
        throw new Error('database is locked')
      },
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
      transport: () => {},
    })
    expect(() => service.start()).not.toThrow()
    expect(() => service.end()).not.toThrow()
  })

  it('defaults to a transport that goes nowhere', () => {
    // Phase 4 owns the host. Until it exists the service must accept payloads
    // and drop them, not queue them onto disk for an address nobody has chosen.
    const service = createTelemetryService({
      rootInstallId: () => ROOT,
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => true,
      facts: () => FACTS,
      newSessionId: () => 'session-1',
    })
    expect(() => {
      service.start()
      service.end()
    }).not.toThrow()
  })
})

describe('readMachineFacts', () => {
  it('reads a zone, never a time or an offset', () => {
    const facts = readMachineFacts({
      appVersion: '1.0.0',
      platform: 'win32',
      osVersion: '10.0.22631',
      arch: 'x64',
      locale: 'pt-BR',
    })
    expect(facts.timezone).toMatch(/^[A-Za-z]+(?:\/[A-Za-z_\-+0-9]+)*$/)
    expect(facts).not.toHaveProperty('firstRunAt')
  })
})
