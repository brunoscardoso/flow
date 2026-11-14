import {
  DEFAULT_READY_TIMEOUT_MS,
  clampReadyTimeout,
  newStepId,
  parseRunSetup,
  resolveRunSteps,
  runScopeKey,
  serializeRunSetup,
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

function project(over: Partial<Parameters<typeof resolveRunSteps>[0][number]> = {}) {
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
    const steps = resolveRunSteps([project()])
    expect(steps.map((s) => s.key)).toEqual(['/p::db', '/p::api'])
    expect(steps[0].from).toEqual({ command: 'shared', ready: 'shared' })
    expect(steps[0].readyTimeoutMs).toBe(DEFAULT_READY_TIMEOUT_MS)
  })

  it('lets conversation beat personal beat shared, field by field', () => {
    const personal: Record<string, RunTweak> = { api: { command: 'p-cmd', ready: { kind: 'port', port: 3000 } } }
    const conversation: Record<string, RunTweak> = { api: { command: 'c-cmd' } }
    const api = resolveRunSteps([project({ personal, conversation })])[1]
    expect(api.command).toBe('c-cmd')
    expect(api.ready).toEqual({ kind: 'port', port: 3000 })
    expect(api.from).toEqual({ command: 'conversation', ready: 'personal' })
  })

  it('removes a ready check with null', () => {
    const api = resolveRunSteps([project({ personal: { api: { ready: null } } })])[1]
    expect(api.ready).toBeUndefined()
    expect(api.from.ready).toBe('personal')
  })

  it('drops skipped steps, and a conversation can un-skip a personal skip', () => {
    expect(resolveRunSteps([project({ personal: { db: { skip: true } } })]).map((s) => s.id)).toEqual(['api'])
    expect(resolveRunSteps([project({ conversation: { db: { skip: true } } })]).map((s) => s.id)).toEqual(['api'])
    expect(
      resolveRunSteps([project({ personal: { db: { skip: true } }, conversation: { db: { skip: false } } })]).map((s) => s.id),
    ).toEqual(['db', 'api'])
  })

  it('keeps tweaks attached to their step when shared steps are reordered', () => {
    const reordered: RunSetup = { version: 1, steps: [...shared.steps].reverse() }
    const steps = resolveRunSteps([project({ setup: reordered, personal: { db: { command: 'mine' } } })])
    expect(steps.map((s) => [s.id, s.command])).toEqual([
      ['api', 'npm run api'],
      ['db', 'mine'],
    ])
  })

  it('orders by project then step and handles a missing setup', () => {
    const steps = resolveRunSteps([project({ root: '/a', name: 'a', setup: null }), project({ root: '/b', name: 'b' })])
    expect(steps.map((s) => s.key)).toEqual(['/b::db', '/b::api'])
  })
})

describe('runScopeKey', () => {
  it('joins the root and thread', () => {
    expect(runScopeKey({ rootPath: '/p', threadId: null })).toBe('/p::')
    expect(runScopeKey({ rootPath: '/p', threadId: 't1' })).toBe('/p::t1')
  })
})
