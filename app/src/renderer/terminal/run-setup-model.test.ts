import type { RunGroupState, RunProjectLayers, RunStepStatus, RunSuggestion } from '../../shared/run-setup'
import {
  addOnceAction,
  addStep,
  addSuggestion,
  changeStep,
  stepSuggestions,
  diffDraft,
  draftFromSuggestions,
  draftToSetUp,
  isDirty,
  moveStep,
  offeredSuggestions,
  removeStep,
  runsInChoices,
  saveChange,
  saveSentence,
  startDraft,
  startsLabel,
  startsOptions,
  stepsOfKind,
  SETUP_STRINGS,
  setupTitle,
  showAllLabel,
  addedAsLabel,
  validateDraft,
  type RunSetupDraft,
} from './run-setup-model'

const ROOT = '/work/jupiter'

function project(extra: Partial<RunProjectLayers> = {}): RunProjectLayers {
  return {
    root: ROOT,
    name: 'jupiter',
    cwd: ROOT,
    hasSharedSetup: true,
    problems: [],
    setup: {
      version: 1,
      steps: [
        { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', ready: { kind: 'port', port: 7233 } },
        { id: 'worker', name: 'worker', command: 'uv run worker', start: 'after-previous' },
        { id: 'api', name: 'api', command: 'uv run api', start: 'after-previous' },
        { id: 'app', name: 'app', command: 'npm run dev', start: 'now' },
      ],
    },
    personal: {},
    conversation: {},
    ...extra,
  }
}

function going(statuses: Record<string, RunStepStatus>): RunGroupState {
  return {
    scopeKey: `${ROOT}::t1`,
    active: true,
    // A saved step's id in the draft IS its key in the Run.
    steps: Object.entries(statuses).map(([id, status]) => ({
      key: id,
      name: id,
      projectRoot: ROOT,
      status,
      terminalId: `t-${id}`,
      exitCode: null,
      detail: null,
    })),
  }
}

const ALL_RUNNING = going({ temporal: 'ready', worker: 'running', api: 'running', app: 'running' })

describe('editing a draft for Everyone', () => {
  it('adds, moves and removes steps', () => {
    let draft = startDraft(project())
    draft = addStep(draft, { name: 'storybook', command: 'npm run storybook' })
    expect(draft.steps.map((s) => s.id)).toEqual(['temporal', 'worker', 'api', 'app', 'storybook'])
    draft = moveStep(draft, 'storybook', 0)
    expect(draft.steps[0].id).toBe('storybook')
    draft = removeStep(draft, 'app')
    expect(draft.removed).toEqual(['app'])
    const diff = diffDraft(draft)
    expect(diff.added.map((s) => s.id)).toEqual(['storybook'])
    expect(diff.removed.map((s) => s.id)).toEqual(['app'])
  })

  it('gives a new step an id no other step has', () => {
    const draft = addStep(startDraft(project()), { name: 'api' })
    expect(draft.steps[4].id).toBe('api-2')
  })

  it('removing a step added in this draft leaves nothing behind', () => {
    let draft = addStep(startDraft(project()), { name: 'x', command: 'y' })
    draft = removeStep(draft, 'x')
    expect(isDirty(draft)).toBe(false)
  })

  it('writes the whole combined list', () => {
    let draft = startDraft(project())
    draft = changeStep(draft, 'app', { readyKind: 'port', readyValue: '5173' })
    const change = saveChange(draft)
    expect(change.layer).toBe('shared')
    expect(change.steps.map((s) => s.id)).toEqual(['temporal', 'worker', 'api', 'app'])
    expect(change.steps.find((s) => s.id === 'app')?.ready).toEqual({ kind: 'port', port: 5173 })
  })

  it('starts from the combined list: each step keeps its reference and knows its project', () => {
    const combined = project({
      setup: {
        version: 1,
        steps: [
          { id: '/work/jupiter-core::temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'jupiter-core' },
          { id: `${ROOT}::api`, name: 'api', command: 'uv run api', start: 'after-previous', runsIn: 'jupiter' },
        ],
      },
    })
    const draft = startDraft(combined)
    expect(draft.steps.map((s) => [s.id, s.runsIn])).toEqual([
      ['/work/jupiter-core::temporal', 'jupiter-core'],
      [`${ROOT}::api`, null],
    ])
    const change = saveChange(changeStep(draft, `${ROOT}::api`, { runsIn: 'jupiter-core' }))
    expect(change).toEqual({
      layer: 'shared',
      steps: [
        { id: '/work/jupiter-core::temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'jupiter-core' },
        { id: `${ROOT}::api`, name: 'api', command: 'uv run api', start: 'after-previous', runsIn: 'jupiter-core' },
      ],
    })
  })

  it('starts from the suggestions the person ticked, each running in its project', () => {
    const draft = draftFromSuggestions(project({ setup: null, hasSharedSetup: false }), [
      { projectRoot: '/work/jupiter-app', projectName: 'jupiter-app', name: 'dev', command: 'npm run dev', source: 'package.json' },
      { projectRoot: ROOT, projectName: 'jupiter', name: 'api', command: 'uv run api', source: 'README' },
    ])
    expect(draft.steps).toHaveLength(2)
    expect(draft.steps[0]).toMatchObject({ name: 'dev', command: 'npm run dev', runsIn: 'jupiter-app', origin: 'jupiter-app · package.json', isNew: true })
    // The setup's own project is not written as a runsIn.
    expect(draft.steps[1]?.runsIn).toBeNull()
  })

  it('"Set up Run" opens with one empty step in the setup\'s own project; an existing setup opens as it is', () => {
    const fresh = draftToSetUp(project({ setup: null, hasSharedSetup: false }))
    expect(fresh.steps).toHaveLength(1)
    expect(fresh.steps[0]).toMatchObject({ name: '', command: '', runsIn: null, start: 'now', isNew: true })
    expect(draftToSetUp(project()).steps).toHaveLength(4)
  })
})

describe('one list across projects', () => {
  const places = [
    { name: 'jupiter', root: ROOT },
    { name: 'jupiter-core', root: '/work/jupiter-core' },
    { name: 'jupiter-app', root: '/work/jupiter-app' },
  ]

  it('orders steps of different projects in one list, and writes runsIn for every project but the main one', () => {
    let draft = startDraft(project({ setup: null }))
    draft = addStep(draft, { name: 'temporal', command: 'temporal server start-dev', runsIn: 'jupiter-core' })
    draft = addStep(draft, { name: 'app', command: 'npm run dev', runsIn: 'jupiter-app' })
    draft = changeStep(draft, 'app', { start: 'after-previous' })
    draft = addStep(draft, { name: 'api', command: 'uv run api', runsIn: 'jupiter' })
    draft = moveStep(draft, 'api', 1)
    const change = saveChange(draft)
    expect(change.steps.map((step) => [step.id, step.runsIn])).toEqual([
      ['temporal', 'jupiter-core'],
      ['api', undefined],
      ['app', 'jupiter-app'],
    ])
  })

  it('moving a step to another project is a change', () => {
    const cross = project()
    let draft = startDraft(cross)
    draft = changeStep(draft, 'temporal', { runsIn: 'jupiter-core' })
    expect(diffDraft(draft).changed.map((step) => step.id)).toEqual(['temporal'])
    draft = changeStep(draft, 'temporal', { runsIn: 'JUPITER' })
    expect(draft.steps[0]?.runsIn).toBeNull()
  })

  it('offers the conversation\'s projects, the main one first, and keeps a project that is not among them', () => {
    const draft = startDraft(project())
    expect(runsInChoices(draft, places, { runsIn: null }).map((choice) => choice.value)).toEqual(['', 'jupiter-core', 'jupiter-app'])
    const lost = runsInChoices(draft, places, { runsIn: 'billing' })
    expect(lost[lost.length - 1]).toEqual({ value: 'billing', label: 'billing · not in this conversation', missing: true })
  })

  it('names the Starts choice after the step above: After X, or When X is ready', () => {
    const draft = startDraft(project())
    expect(startsOptions(draft.steps, 0)).toEqual([
      { value: 'now', label: 'Right away', disabled: false },
      { value: 'after-previous', label: 'After the step above', disabled: true },
    ])
    // temporal has a ready check; worker has none.
    expect(startsOptions(draft.steps, 1)[1]?.label).toBe('When temporal is ready')
    expect(startsOptions(draft.steps, 2)[1]?.label).toBe('After worker')
  })

  it('titles the setup with the conversation\'s projects', () => {
    expect(setupTitle(places)).toBe('Launchpad for jupiter, jupiter-core, jupiter-app')
    expect(setupTitle([], 'jupiter')).toBe('Launchpad for jupiter')
    expect(setupTitle([])).toBe('Launchpad')
  })
})

describe('the Suggested list', () => {
  const s = (projectName: string, command: string, source = 'package.json'): RunSuggestion => ({
    projectRoot: `/work/${projectName}`,
    projectName,
    name: command.split(' ').pop() ?? command,
    command,
    source,
  })
  const found = [
    s('jupiter-app', 'npm run storybook', 'you ran it 6 times'),
    s('jupiter-core', 'docker compose up kafka', 'the agent started it'),
    s('jupiter-app', 'npm run storybook', 'package.json'),
    s('jupiter', 'npm run dev'),
    s('jupiter-core', 'make up'),
    s('jupiter-app', 'npm run preview'),
    s('jupiter-core', 'make watch'),
  ]

  it('shows the top four, de-duplicated, leaving out what is already a saved step', () => {
    const offered = offeredSuggestions(startDraft(project()), found)
    // "npm run dev" in jupiter is the saved step "app".
    expect(offered.total).toBe(5)
    expect(offered.top.map((item) => item.suggestion.command)).toEqual([
      'npm run storybook',
      'docker compose up kafka',
      'make up',
      'npm run preview',
    ])
    expect(offered.top[0]?.meta).toBe('jupiter-app · you ran it 6 times')
    expect(showAllLabel(offered.total)).toBe('Show all (5)')
  })

  it('groups the full list by project', () => {
    const offered = offeredSuggestions(startDraft(project()), found)
    expect(offered.groups.map((group) => [group.projectName, group.items.length])).toEqual([
      ['jupiter-app', 2],
      ['jupiter-core', 3],
    ])
  })

  it('a suggestion added in this draft says which step it became', () => {
    const draft = addSuggestion(startDraft(project()), found[1]!)
    const offered = offeredSuggestions(draft, found)
    const kafka = offered.top.find((item) => item.suggestion.command === 'docker compose up kafka')
    expect(kafka?.addedAs).toBe(5)
    expect(addedAsLabel(5)).toBe('Added as step 5')
    expect(draft.steps[4]).toMatchObject({ runsIn: 'jupiter-core', command: 'docker compose up kafka' })
  })

  it('a suggestion whose name is taken gets its project added', () => {
    const draft = addSuggestion(startDraft(project()), s('jupiter-core', 'npm run app'))
    expect(draft.steps[4]?.name).toBe('app (jupiter-core)')
  })
})

describe('validateDraft', () => {
  it('an untouched empty row is not a problem, and is not a change', () => {
    const draft = addStep(startDraft(project({ setup: { version: 1, steps: [] } })))
    expect(validateDraft(draft)).toEqual([])
    expect(isDirty(draft)).toBe(false)
  })

  it('a step with a command and no name is named from the command on Save', () => {
    let draft = addStep(startDraft(project({ setup: { version: 1, steps: [] } })))
    draft = changeStep(draft, draft.steps[0]!.id, { command: 'npm run dev' })
    draft = addStep(draft)
    expect(validateDraft(draft)).toEqual([])
    const change = saveChange(draft)
    expect(change.steps.map((step) => [step.name, step.command])).toEqual([
      ['dev', 'npm run dev'],
    ])
  })

  it('names each problem in plain words', () => {
    let draft = startDraft(project())
    draft = addStep(draft)
    const blankId = draft.steps[draft.steps.length - 1]!.id
    draft = changeStep(draft, blankId, { name: 'cache' })
    draft = changeStep(draft, 'app', { name: 'api' })
    draft = changeStep(draft, 'temporal', { readyValue: 'abc' })
    draft = changeStep(draft, 'worker', { readyKind: 'line', readyValue: ' ' })
    expect(validateDraft(draft)).toEqual([
      '“temporal” waits for a port, but “abc” is not a port number.',
      '“worker” waits for a line, but the text to wait for is empty.',
      '“cache” needs a command to run.',
      'Two steps are called “api”. Give each its own name.',
    ])
  })

  it('the first step cannot wait for a step above it', () => {
    const draft = moveStep(startDraft(project()), 'worker', 0)
    expect(validateDraft(draft)).toEqual([
      '“worker” is the first step, so it has no step to wait for. Set it to start right away.',
    ])
  })

})

describe('saveSentence', () => {
  it('says nothing changed for an untouched draft', () => {
    expect(saveSentence(startDraft(project()), ALL_RUNNING)).toBe('Nothing has changed yet.')
  })

  it('reads like the mockup when one step is added to a going Run', () => {
    const draft = addSuggestion(startDraft(project()), {
      projectRoot: ROOT,
      projectName: 'jupiter-app',
      name: 'storybook',
      command: 'npm run storybook',
      source: 'package.json',
    })
    expect(saveSentence(draft, ALL_RUNNING)).toBe(
      'Saving starts the new step. The four running ones keep running. Kept on this computer, for every conversation with these projects.',
    )
  })

  it('names a restart and a stop, and counts the rest', () => {
    let draft = startDraft(project())
    draft = changeStep(draft, 'api', { command: 'uv run api --reload' })
    draft = removeStep(draft, 'app')
    expect(saveSentence(draft, ALL_RUNNING)).toBe(
      'Saving restarts “api” and stops “app”. The two other running ones keep running. Kept on this computer, for every conversation with these projects.',
    )
  })

  it('says nothing starts until Run when no Run is going', () => {
    const draft = removeStep(startDraft(project()), 'app')
    expect(saveSentence(draft, null)).toBe(
      'Saving keeps the new setup; nothing starts until you press Run. Kept on this computer, for every conversation with these projects.',
    )
  })
})

describe('startsLabel', () => {
  it('says when a step starts and when it is ready', () => {
    const draft = startDraft(project())
    expect(startsLabel(draft.steps, 0)).toBe('right away · ready on port 7233')
    expect(startsLabel(draft.steps, 1)).toBe('when temporal is ready')
    expect(startsLabel(draft.steps, 2)).toBe('after worker')
  })
})

describe('UI text (forbidden-pattern #12)', () => {
  it('no sentence the panel composes names a path, a setting or a command line', () => {
    let draft = startDraft(project())
    draft = addStep(draft)
    draft = changeStep(draft, 'temporal', { readyValue: '' })
    draft = removeStep(draft, 'app')
    const sentences = [
      ...validateDraft(draft),
      saveSentence(draft, ALL_RUNNING),
      saveSentence(draft, null),
      saveSentence(removeStep(startDraft(project()), 'api'), ALL_RUNNING),
      setupTitle([{ name: 'jupiter-app' }, { name: 'jupiter-core' }]),
      ...validateDraft(moveStep(startDraft(project()), 'worker', 0)),
      ...Object.values(SETUP_STRINGS),
      ...startsOptions(draft.steps, 2).map((option) => option.label),
      showAllLabel(9),
      addedAsLabel(2),
    ]
    for (const text of sentences) {
      expect(text).not.toMatch(/planflow-ai|`|flow\/|setup\.json|\.json\b|\b[a-z]+_[a-z_]+\b|(^|\s)--?[a-z]/)
    }
  })
})

describe('turning a step off', () => {
  it('a step turned off is kept, saved as off, and read back off', () => {
    const layers = project()
    const draft = changeStep(startDraft(layers), 'worker', { skipped: true })
    const steps = saveChange(draft).steps
    expect(steps.map((step) => step.id)).toContain('worker')
    expect(steps.find((step) => step.id === 'worker')?.disabled).toBe(true)
    expect(steps.find((step) => step.id === 'api')?.disabled).toBeUndefined()
    const reread = startDraft(project({ setup: { version: 1, steps } }))
    expect(reread.steps.find((step) => step.id === 'worker')?.skipped).toBe(true)
  })
})

describe('stepSuggestions — each step offers its own project, five at most', () => {
  const sug = (projectName: string, command: string, name = command.split(' ').pop()!): RunSuggestion => ({
    projectRoot: `/${projectName}`, projectName, name, command, source: 'package.json',
  })
  const all = [
    sug('jupiter', 'npm run dev'), sug('jupiter', 'npm start'), sug('jupiter', 'npm run storybook'),
    sug('jupiter', 'npm run preview'), sug('jupiter', 'npm run serve'), sug('jupiter', 'npm run watch'),
    sug('core', 'uv run python -m core', 'core'), sug('core', 'docker compose up postgres', 'postgres'),
  ]
  const empty = (): RunSetupDraft => addStep(startDraft(project({ setup: { version: 1, steps: [] } })))

  it('the main project by default, capped at five', () => {
    const draft = empty()
    const found = stepSuggestions(draft, draft.steps[0]!.id, all)
    expect(found).toHaveLength(5)
    expect(found.every((s) => s.projectName === 'jupiter')).toBe(true)
  })

  it('follows the project the step runs in, and what is typed', () => {
    let draft = empty()
    const id = draft.steps[0]!.id
    draft = changeStep(draft, id, { runsIn: 'core' })
    expect(stepSuggestions(draft, id, all).map((s) => s.command)).toEqual(['uv run python -m core', 'docker compose up postgres'])
    draft = changeStep(draft, id, { command: 'postg' })
    expect(stepSuggestions(draft, id, all).map((s) => s.command)).toEqual(['docker compose up postgres'])
  })

  it('leaves out what another step of that project already runs', () => {
    let draft = empty()
    draft = changeStep(draft, draft.steps[0]!.id, { command: 'npm run dev' })
    draft = addStep(draft)
    const second = draft.steps[1]!.id
    expect(stepSuggestions(draft, second, all).map((s) => s.command)).not.toContain('npm run dev')
  })
})

describe('one-time actions in the draft', () => {
  function mixed(): RunProjectLayers {
    return project({
      setup: {
        version: 1,
        steps: [
          { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now' },
          { id: 'migrate', name: 'migrate', command: 'uv run alembic upgrade head', start: 'now', kind: 'once', confirm: true },
          { id: 'app', name: 'app', command: 'npm run dev', start: 'now' },
          { id: 'gen', name: 'codegen', command: 'npm run codegen', start: 'now', kind: 'once' },
        ],
      },
    })
  }

  it('reads kind and confirm from the saved setup, and splits the list by kind', () => {
    const draft = startDraft(mixed())
    expect(stepsOfKind(draft, 'service').map((step) => step.id)).toEqual(['temporal', 'app'])
    expect(stepsOfKind(draft, 'once').map((step) => [step.id, step.confirm])).toEqual([
      ['migrate', true],
      ['gen', false],
    ])
  })

  it('a new action asks first while its command reads as a migration, until the person decides', () => {
    let draft = addOnceAction(startDraft(project()))
    const id = draft.steps[draft.steps.length - 1]!.id
    expect(draft.steps.find((step) => step.id === id)).toMatchObject({ kind: 'once', confirm: false, isNew: true })
    draft = changeStep(draft, id, { command: 'npx prisma migrate dev' })
    expect(draft.steps.find((step) => step.id === id)!.confirm).toBe(true)
    draft = changeStep(draft, id, { command: 'npx prisma generate' })
    expect(draft.steps.find((step) => step.id === id)!.confirm).toBe(false)
    draft = changeStep(draft, id, { confirm: true })
    draft = changeStep(draft, id, { command: 'npm run codegen' })
    expect(draft.steps.find((step) => step.id === id)!.confirm).toBe(true)
  })

  it('a saved action keeps its choice when its command changes', () => {
    const draft = changeStep(startDraft(mixed()), 'gen', { command: 'npm run db:migrate' })
    expect(draft.steps.find((step) => step.id === 'gen')!.confirm).toBe(false)
  })

  it('saves kind and confirm, and no start mode or ready check for an action', () => {
    let draft = startDraft(mixed())
    draft = changeStep(draft, 'migrate', { start: 'after-previous', readyKind: 'port', readyValue: '9', confirm: false })
    draft = addOnceAction(draft, { name: 'seed', command: 'npm run seed' })
    const steps = saveChange(draft).steps
    expect(steps.find((step) => step.id === 'migrate')).toEqual({ id: 'migrate', name: 'migrate', command: 'uv run alembic upgrade head', start: 'now', kind: 'once' })
    expect(steps.find((step) => step.name === 'seed')).toMatchObject({ kind: 'once', confirm: true, start: 'now' })
    expect(steps.find((step) => step.id === 'app')).toEqual({ id: 'app', name: 'app', command: 'npm run dev', start: 'now' })
  })

  it('moves an entry among its own kind only; the other kind keeps its places', () => {
    const draft = startDraft(mixed())
    expect(moveStep(draft, 'app', 0).steps.map((step) => step.id)).toEqual(['app', 'migrate', 'temporal', 'gen'])
    expect(moveStep(draft, 'gen', 0).steps.map((step) => step.id)).toEqual(['temporal', 'gen', 'app', 'migrate'])
    expect(moveStep(draft, 'migrate', 5).steps.map((step) => step.id)).toEqual(['temporal', 'gen', 'app', 'migrate'])
  })

  it('the first RUNNING step may not wait for the one above, whatever actions stand before it', () => {
    let draft = startDraft(
      project({
        setup: {
          version: 1,
          steps: [
            { id: 'm', name: 'm', command: 'make migrate', start: 'now', kind: 'once' },
            { id: 'web', name: 'web', command: 'npm run dev', start: 'now' },
          ],
        },
      }),
    )
    draft = changeStep(draft, 'web', { start: 'after-previous' })
    expect(validateDraft(draft)).toEqual(['“web” is the first step, so it has no step to wait for. Set it to start right away.'])
  })

  it('adding or changing an action while steps run starts, restarts and stops nothing', () => {
    let draft = startDraft(mixed())
    draft = addOnceAction(draft, { name: 'seed', command: 'npm run seed' })
    draft = changeStep(draft, 'gen', { command: 'npm run gen' })
    draft = removeStep(draft, 'migrate')
    const state = going({ temporal: 'running', app: 'running' })
    expect(saveSentence(draft, state)).toBe(
      'Saving changes no running step. The two running ones keep running. Kept on this computer, for every conversation with these projects.',
    )
  })

  it('a step offers only suggestions of its kind and its project, at most five', () => {
    const s = (command: string, use?: 'once', projectName = 'jupiter'): RunSuggestion => ({
      projectRoot: ROOT, projectName, name: command, command, source: 'package.json', ...(use === undefined ? {} : { use }),
    })
    const suggestions = [
      s('npm run storybook'),
      s('npm run db:migrate', 'once'),
      s('npm run seed', 'once'),
      s('make migrate', 'once', 'other'),
      ...['a', 'b', 'c', 'd', 'e'].map((x) => s(`npm run gen:${x}`, 'once')),
    ]
    let draft = addOnceAction(startDraft(mixed()))
    const action = draft.steps[draft.steps.length - 1]!.id
    draft = addStep(draft)
    const step = draft.steps[draft.steps.length - 1]!.id
    expect(stepSuggestions(draft, action, suggestions).map((x) => x.command)).toEqual([
      'npm run db:migrate',
      'npm run seed',
      'npm run gen:a',
      'npm run gen:b',
      'npm run gen:c',
    ])
    expect(stepSuggestions(draft, step, suggestions).map((x) => x.command)).toEqual(['npm run storybook'])
    expect(offeredSuggestions(draft, suggestions).total).toBe(1)
  })
})
