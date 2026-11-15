import {
  DEFAULT_READY_TIMEOUT_MS,
  clampReadyTimeout,
  confirmByDefault,
  mergeRunOrder,
  newStepId,
  notHereSentence,
  parseRunSaveSteps,
  parseRunSetup,
  parseRunStepRef,
  placeOfStep,
  resolveOnceSteps,
  resolveRunSteps,
  runScopeKey,
  runStepRef,
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

describe('a step turned off', () => {
  it('round-trips and is never resolved to run', () => {
    const setup = parseRunSetup(
      serializeRunSetup({ version: 1, steps: [
        { id: 'a', name: 'a', command: 'npm run dev', start: 'now', disabled: true },
        { id: 'b', name: 'b', command: 'npm start', start: 'now' },
      ] }),
    ).setup
    expect(setup.steps[0]!.disabled).toBe(true)
    expect(setup.steps[1]!.disabled).toBeUndefined()
    const steps = resolveRunSteps({ root: '/p', name: 'p', cwd: '/p', setup, personal: {}, conversation: {} })
    expect(steps.map((step) => step.id)).toEqual(['b'])
  })
})

describe('step references and the one order', () => {
  it('a reference names the project a step is stored with and its id', () => {
    expect(runStepRef('/work/a::b', 'web')).toBe('/work/a::b::web')
    expect(parseRunStepRef('/work/a::b::web')).toEqual({ root: '/work/a::b', id: 'web' })
    expect(parseRunStepRef('web')).toBeNull()
    expect(parseRunStepRef('/work/a::')).toBeNull()
  })

  it('a save takes out what its conversation could see and puts its list back where the first of them was', () => {
    const order = ['a1', 'b1', 'a2', 'b2', 'c1']
    expect(mergeRunOrder(order, new Set(['b1', 'b2', 'c1']), ['c1', 'b2', 'd1'])).toEqual(['a1', 'c1', 'b2', 'd1', 'a2'])
  })

  it('a list the order has never seen goes at the end; other references keep their places', () => {
    expect(mergeRunOrder(['a1', 'a2'], new Set(['b1']), ['b1', 'd1'])).toEqual(['a1', 'a2', 'b1', 'd1'])
    expect(mergeRunOrder([], new Set(), ['x'])).toEqual(['x'])
    expect(mergeRunOrder(['a1', 'b1'], new Set(['b1']), [])).toEqual(['a1'])
  })

  it('a moved step leaves no stale reference behind', () => {
    expect(mergeRunOrder(['b1', 'c1'], new Set(['b1', 'c1']), ['c1', 'c2'])).toEqual(['c1', 'c2'])
  })
})

describe('parseRunSaveSteps', () => {
  it('keeps each id as sent, re-checks every field and drops what cannot be read', () => {
    expect(
      parseRunSaveSteps([
        { id: '/work/a::web', name: 'Web', command: 'npm run dev', start: 'now', evil: true },
        { id: '/work/a::web', name: 'Again', command: 'x', start: 'now' },
        { name: 'Worker', command: 'uv run worker', start: 'after-previous', runsIn: 'core', disabled: true },
        { name: '' },
        'nope',
      ]),
    ).toEqual([
      { id: '/work/a::web', name: 'Web', command: 'npm run dev', start: 'now' },
      { id: 'work-a-web', name: 'Again', command: 'x', start: 'now' },
      { id: 'worker', name: 'Worker', command: 'uv run worker', start: 'after-previous', runsIn: 'core', disabled: true },
    ])
    expect(parseRunSaveSteps({ steps: [] })).toEqual([])
  })
})

describe('one-time actions (kind: once)', () => {
  const withOnce: RunSetup = {
    version: 1,
    steps: [
      { id: 'db', name: 'Database', command: 'docker compose up db', start: 'now' },
      { id: 'migrate', name: 'Migrate', command: 'uv run alembic upgrade head', start: 'now', kind: 'once', confirm: true },
      { id: 'gen', name: 'Codegen', command: 'npm run codegen', start: 'now', kind: 'once' },
      { id: 'off', name: 'Seed', command: 'npm run seed', start: 'now', kind: 'once', confirm: true, disabled: true },
    ],
  }

  it('round-trips kind and confirm, and older entries (no kind) read unchanged', () => {
    const text = serializeRunSetup(withOnce)
    const { setup, problems } = parseRunSetup(text)
    expect(problems).toEqual([])
    expect(setup).toEqual(withOnce)
    expect(text).not.toContain('"service"')
    expect(JSON.parse(text).steps[0]).toEqual({ id: 'db', name: 'Database', command: 'docker compose up db', start: 'now' })
  })

  it('reads kind: service as a running step, and drops what a once step cannot have', () => {
    const { setup } = parseRunSetup(
      JSON.stringify({
        version: 1,
        steps: [
          { id: 'a', name: 'a', command: 'npm run dev', start: 'now', kind: 'service', confirm: true },
          { id: 'b', name: 'b', command: 'npm run migrate', start: 'after-previous', kind: 'once', ready: { kind: 'port', port: 1 }, readyTimeoutMs: 9000, confirm: 'yes' },
        ],
      }),
    )
    expect(setup.steps[0]).toEqual({ id: 'a', name: 'a', command: 'npm run dev', start: 'now' })
    expect(setup.steps[1]).toEqual({ id: 'b', name: 'b', command: 'npm run migrate', start: 'now', kind: 'once' })
  })

  it('leaves out an entry of an unknown kind with a plain sentence, never runs it as a step', () => {
    const { setup, problems } = parseRunSetup(
      JSON.stringify({ version: 1, steps: [{ id: 'x', name: 'Nightly', command: 'npm run x', kind: 'scheduled' }, { id: 'y', name: 'y', command: 'npm run y', kind: 42 }] }),
    )
    expect(setup.steps).toEqual([])
    expect(problems).toEqual([
      'The step "Nightly" is of a kind this version of Flow can\'t run, so it was left out.',
      'The step "y" is of a kind this version of Flow can\'t run, so it was left out.',
    ])
  })

  it('a save keeps kind and confirm as sent', () => {
    expect(parseRunSaveSteps([{ id: '/p::m', name: 'm', command: 'npm run migrate', kind: 'once', confirm: true }])).toEqual([
      { id: '/p::m', name: 'm', command: 'npm run migrate', start: 'now', kind: 'once', confirm: true },
    ])
  })

  it('Run never resolves a once step; the menu gets the enabled ones, with confirm', () => {
    const input = project({ setup: withOnce })
    expect(resolveRunSteps(input).map((step) => step.id)).toEqual(['db'])
    const once = resolveOnceSteps(input)
    expect(once.map((step) => [step.id, step.kind, step.confirm ?? false])).toEqual([
      ['migrate', 'once', true],
      ['gen', 'once', false],
    ])
    expect(once[0]).toMatchObject({ cwd: '/p', projectName: 'p', start: 'now' })
    expect(once[0]!.ready).toBeUndefined()
  })
})

describe('confirmByDefault', () => {
  it('asks first for migrations, schema pushes and seeds', () => {
    for (const command of [
      'alembic upgrade head',
      'uv run alembic downgrade -1',
      'npx prisma migrate dev',
      'npx prisma db push',
      'npx prisma db seed',
      'npx drizzle-kit push',
      'npx drizzle-kit migrate',
      'python manage.py migrate',
      'npx knex migrate:latest',
      'npx typeorm migration:run -d src/data-source.ts',
      'bin/rails db:migrate',
      'rails db:seed',
      'npm run db:migrate',
      'npm run seed',
      'make migrate',
    ])
      expect([command, confirmByDefault(command)]).toEqual([command, true])
  })

  it('does not ask for codegen, tests or an empty command', () => {
    for (const command of ['', 'npm run codegen', 'npx prisma generate', 'pytest', 'npm test', 'python manage.py makemigrations', 'npm run build'])
      expect([command, confirmByDefault(command)]).toEqual([command, false])
  })
})
