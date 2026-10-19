import {
  ALLOWED_FIELDS,
  EVENT_FIELDS,
  FORBIDDEN_FIELDS,
  INSTALL_FIELDS,
  isAllowed,
  refusalsFor,
  EVENT_NAMES,
} from './telemetry-allowlist'

describe('the allowlist is the contract', () => {
  it('permits an install payload', () => {
    expect(
      isAllowed({ installId: 'flow-ide-9f3a', appVersion: '0.1.11', platform: 'darwin' }),
    ).toBe(true)
  })

  it('permits a usage event', () => {
    expect(isAllowed({ event: 'session.started', at: 1, durationMs: 12, provider: 'anthropic' })).toBe(
      true,
    )
  })

  it('REFUSES an unknown field rather than dropping it', () => {
    // A quiet drop is how a new event's helpful `detail` field ships: it works
    // in development, nobody sees a warning, and "no content leaves" stops
    // being true without a line saying so.
    const refusals = refusalsFor({ event: 'session.started', detail: 'anything at all' })
    expect(refusals).toEqual([{ field: 'detail', reason: 'not-on-the-allowlist' }])
  })

  it('refuses the dangerous names BY NAME, as a second guard', () => {
    // The allowlist alone is safe until somebody adds a plausible-looking key
    // to it. This is what a reviewer reads to see the dangerous ones were
    // considered and refused deliberately.
    for (const field of ['prompt', 'filePath', 'repository', 'branch', 'stackTrace', 'errorMessage']) {
      expect(refusalsFor({ [field]: 'x' })).toEqual([{ field, reason: 'forbidden-by-name' }])
    }
  })

  it('reports EVERY problem, not just the first', () => {
    // A caller fixing an event wants the whole list; one at a time is a test
    // somebody runs four times.
    expect(refusalsFor({ prompt: 'a', detail: 'b', event: 'session.started' })).toHaveLength(2)
  })

  it('has no field on both lists, which would be a contradiction', () => {
    const both = ALLOWED_FIELDS.filter((field) => FORBIDDEN_FIELDS.includes(field))
    expect(both).toEqual([])
  })

  it('carries nothing that could hold a name', () => {
    // The whole promise in one assertion: no allowed field is a place a file,
    // project, branch or repository name could legitimately be put.
    const namelike = ALLOWED_FIELDS.filter((field) =>
      /path|file|repo|project(?!Count)|branch|url|title|prompt|message|content/i.test(field),
    )
    expect(namelike).toEqual([])
  })

  it('rules OUT every diagnostic error field', () => {
    // The consequence of the field ruling, written down: a crash is a rate here
    // and never a diagnosis.
    for (const field of ['errorName', 'errorMessage', 'stackTrace', 'breadcrumbs']) {
      expect(ALLOWED_FIELDS).not.toContain(field)
    }
    // …and `errorKind` IS allowed, because it comes from a vocabulary this app
    // owns rather than from the error.
    expect(EVENT_FIELDS).toContain('errorKind')
  })

  it('keeps the install id that already exists rather than minting another', () => {
    expect(INSTALL_FIELDS).toContain('installId')
  })

  it('is empty-safe', () => {
    expect(isAllowed({})).toBe(true)
  })
})

describe('the event vocabulary', () => {
  it('permits the names it knows', () => {
    for (const name of EVENT_NAMES) {
      expect(refusalsFor({ event: name, at: 1 })).toEqual([])
    }
  })

  // THE HOLE THIS CLOSES. The allowlist checks KEYS, and `event` is a key it
  // permits — so a name built from a project would have passed every check the
  // contract made. The value is the leak, and no field-level rule can see it.
  it('refuses a name built out of something private', () => {
    const refusals = refusalsFor({ event: 'opened-acme-payments-api', at: 1 })
    expect(refusals).toEqual([{ field: 'event', reason: 'not-in-the-event-vocabulary' }])
  })

  it('refuses a name that merely looks plausible', () => {
    expect(isAllowed({ event: 'session.start', at: 1 })).toBe(false)
    expect(isAllowed({ event: 'sessionStart', at: 1 })).toBe(false)
  })

  // A payload with no `event` at all is an install report, not a usage event.
  it('leaves an install payload alone', () => {
    expect(refusalsFor({ installId: 'abc', platform: 'darwin' })).toEqual([])
  })
})
