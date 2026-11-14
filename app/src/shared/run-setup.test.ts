import {
  DEFAULT_READY_TIMEOUT_MS,
  clampReadyTimeout,
  newStepId,
  notHereSentence,
  parseRunSetup,
  placeOfStep,
  resolveRunSteps,
  runScopeKey,
  serializeRunSetup,
  type RunPlace,
  type RunSetup,
  type RunTweak,
} from './run-setup'

const shared: RunSetup = {
  version: 1,
  steps: [
    { id: 'db', name: 'Database', command: 'docker compose up db', start: 'now', ready: { kind: 'port', port: 5432 } },
    { id: 'api', name: 'API', command: 'npm run api', start: 'after-previous', ready: { kind: 'line', text: 'listening' } },
  ],
}

function project(over: Partial<Parameters<typeof resolveRunSteps>[0]> = {}) {
  return { root: '/p', name: 'p', cwd: '/p', setup: shared, personal: {}, conversation: {}, ...over }
}

describe('parseRunSetup', () => {
  it('reads a valid setup with no problems', () => {
    const { setup, problems } = parseRunSetup(serializeRunSetup(shared))
    expect(problems).toEqual([])
    expect(setup).toEqual(shared)
  })

  it('never throws on invalid JSON', () => {
    const { setup, problems } = parseRunSetup('{nope')
    expect(setup).toEqual({ version: 1, steps: [] })
    expect(problems).toHaveLength(1)
  })

  it('drops malformed steps with a plain-words reason each', () => {
    const { setup, problems } = parseRunSetup(
      JSON.stringify({
        steps: [
          { id: 'ok', name: 'Ok', command: 'a' },
          { command: 'x' },
          { name: 'No command' },
          { name: 'Bad port', command: 'x', ready: { kind: 'port', port: 70000 } },
          { name: 'Empty line', command: 'x', ready: { kind: 'line', text: '  ' } },
          'junk',
        ],
      }),
    )
    expect(setup.steps.map((s) => s.id)).toEqual(['ok'])
    expect(problems).toHaveLength(5)
    for (const problem of problems) expect(problem).not.toMatch(/json|\.json|\//i)
  })

  it('dedupes ids by suffixing and ignores unknown fields', () => {
    const { setup } = parseRunSetup(
      JSON.stringify({
        steps: [
          { id: 'web', name: 'Web', command: 'a', extra: 1 },
          { id: 'web', name: 'Web again', command: 'b' },
          { name: 'Web', command: 'c' },
        ],
      }),
    )
    expect(setup.steps.map((s) => s.id)).toEqual(['web', 'web-2', 'web-3'])
    expect(setup.steps[0]).not.toHaveProperty('extra')
  })

  it('clamps a step timeout', () => {
    const { setup } = parseRunSetup(JSON.stringify({ steps: [{ name: 'A', command: 'a', readyTimeoutMs: 1 }] }))
    expect(setup.steps[0].readyTimeoutMs).toBe(5_000)
    expect(clampReadyTimeout(undefined)).toBe(DEFAULT_READY_TIMEOUT_MS)
    expect(clampReadyTimeout(10 ** 9)).toBe(600_000)
  })
})

describe('serializeRunSetup', () => {
  it('is stable, 2-space JSON with a trailing newline', () => {
    const text = serializeRunSetup(shared)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "steps": [')
    expect(serializeRunSetup(parseRunSetup(text).setup)).toBe(text)
  })
})

describe('newStepId', () => {
  it('slugs, uniquifies and falls back', () => {
    expect(newStepId('My API!', [])).toBe('my-api')
    expect(newStepId('My API', ['my-api'])).toBe('my-api-2')
    expect(newStepId('My API', ['my-api', 'my-api-2'])).toBe('my-api-3')
    expect(newStepId('???', [])).toBe('step')
  })
})

describe('resolveRunSteps', () => {
  it('returns shared steps untouched when nobody tweaked them', () => {
    const steps = resolveRunSteps(project())
    expect(steps.map((s) => s.key)).toEqual(['/p::db', '/p::api'])
    expect(steps[0].from).toEqual({ command: 'shared', ready: 'shared' })
    expect(steps[0].readyTimeoutMs).toBe(DEFAULT_READY_TIMEOUT_MS)
  })

  it('lets conversation beat personal beat shared, field by field', () => {
    const personal: Record<string, RunTweak> = { api: { command: 'p-cmd', ready: { kind: 'port', port: 3000 } } }
    const conversation: Record<string, RunTweak> = { api: { command: 'c-cmd' } }
    const api = resolveRunSteps(project({ personal, conversation }))[1]
    expect(api.command).toBe('c-cmd')
    expect(api.ready).toEqual({ kind: 'port', port: 3000 })
    expect(api.from).toEqual({ command: 'conversation', ready: 'personal' })
  })

  it('removes a ready check with null', () => {
    const api = resolveRunSteps(project({ personal: { api: { ready: null } } }))[1]
    expect(api.ready).toBeUndefined()
    expect(api.from.ready).toBe('personal')
  })

  it('drops skipped steps, and a conversation can un-skip a personal skip', () => {
    expect(resolveRunSteps(project({ personal: { db: { skip: true } } })).map((s) => s.id)).toEqual(['api'])
    expect(resolveRunSteps(project({ conversation: { db: { skip: true } } })).map((s) => s.id)).toEqual(['api'])
    expect(
      resolveRunSteps(project({ personal: { db: { skip: true } }, conversation: { db: { skip: false } } })).map((s) => s.id),
    ).toEqual(['db', 'api'])
  })

  it('keeps tweaks attached to their step when shared steps are reordered', () => {
    const reordered: RunSetup = { version: 1, steps: [...shared.steps].reverse() }
    const steps = resolveRunSteps(project({ setup: reordered, personal: { db: { command: 'mine' } } }))
    expect(steps.map((s) => [s.id, s.command])).toEqual([
      ['api', 'npm run api'],
      ['db', 'mine'],
    ])
  })

  it('handles a missing setup', () => {
    expect(resolveRunSteps(project({ setup: null }))).toEqual([])
  })
})

describe('runsIn', () => {
  const cross: RunSetup = {
    version: 1,
    steps: [
      { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'jupiter-core', ready: { kind: 'port', port: 7233 } },
      { id: 'app', name: 'app', command: 'npm run dev', start: 'after-previous' },
      { id: 'own', name: 'own', command: 'x', start: 'now', runsIn: 'P' },
    ],
  }
  const places: RunPlace[] = [
    { name: 'p', root: '/p', cwd: '/p-checkout', from: 'scope' },
    { name: 'jupiter-core', root: '/core', cwd: '/core-checkout', from: 'scope' },
  ]

  it('round-trips through serialize and parse', () => {
    const text = serializeRunSetup(cross)
    expect(text).toContain('"runsIn": "jupiter-core"')
    expect(parseRunSetup(text).setup).toEqual(cross)
  })

  it('drops a runsIn that is not a non-empty string, with a plain sentence', () => {
    const { setup, problems } = parseRunSetup(
      JSON.stringify({ steps: [{ name: 'A', command: 'a', runsIn: 42 }, { name: 'B', command: 'b', runsIn: '  ' }] }),
    )
    expect(setup.steps.map((step) => step.runsIn)).toEqual([undefined, undefined])
    expect(problems).toHaveLength(2)
    for (const problem of problems) expect(problem).not.toMatch(/runsIn|json|\//i)
  })

  it('runs a step in the named project, in its conversation checkout', () => {
    const steps = resolveRunSteps(project({ setup: cross, cwd: '/p-checkout' }), places)
    expect(steps[0]).toMatchObject({ key: '/p::temporal', projectRoot: '/core', projectName: 'jupiter-core', cwd: '/core-checkout' })
    expect(steps[0].unavailable).toBeUndefined()
    expect(steps[1]).toMatchObject({ key: '/p::app', projectRoot: '/p', cwd: '/p-checkout' })
    // A runsIn naming the setup's own project (any case) is the setup's own project.
    expect(steps[2]).toMatchObject({ projectRoot: '/p', projectName: 'p' })
  })

  it('runs a step in a Workspace sibling on this computer, in its folder', () => {
    const sibling: RunPlace[] = [{ name: 'jupiter-core', root: '/core', cwd: '/core', from: 'workspace' }]
    expect(resolveRunSteps(project({ setup: cross }), sibling)[0]).toMatchObject({ projectRoot: '/core', cwd: '/core' })
  })

  it('marks a step whose project is not on this computer, keeping its key and name', () => {
    const step = resolveRunSteps(project({ setup: cross }), [])[0]
    expect(step).toMatchObject({ key: '/p::temporal', projectName: 'jupiter-core' })
    expect(step.unavailable).toBe(notHereSentence('jupiter-core'))
    expect(step.unavailable).toBe("jupiter-core is not on this computer, so this step can't start.")
  })

  it('placeOfStep ignores a place with no folder here', () => {
    const place = placeOfStep({ runsIn: 'ghost' }, { root: '/p', name: 'p', cwd: '/p' }, [
      { name: 'ghost', root: null, cwd: null, from: 'workspace' },
    ])
    expect(place.unavailable).toBeDefined()
  })
})

describe('runScopeKey', () => {
  it('joins the root and thread', () => {
    expect(runScopeKey({ rootPath: '/p', threadId: null })).toBe('/p::')
    expect(runScopeKey({ rootPath: '/p', threadId: 't1' })).toBe('/p::t1')
  })
})
