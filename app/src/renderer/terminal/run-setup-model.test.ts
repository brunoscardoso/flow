import type { RunGroupState, RunProjectLayers, RunStepStatus, RunSuggestion } from '../../shared/run-setup'
import {
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
  SETUP_STRINGS,
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
    steps: Object.entries(statuses).map(([id, status]) => ({
      key: `${ROOT}::${id}`,
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
    let draft = startDraft(project(), 'shared')
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
    const draft = addStep(startDraft(project(), 'shared'), { name: 'api' })
    expect(draft.steps[4].id).toBe('api-2')
  })

  it('removing a step added in this draft leaves nothing behind', () => {
    let draft = addStep(startDraft(project(), 'shared'), { name: 'x', command: 'y' })
    draft = removeStep(draft, 'x')
    expect(isDirty(draft)).toBe(false)
  })

  it('writes the whole list for Everyone', () => {
    let draft = startDraft(project(), 'shared')
    draft = changeStep(draft, 'app', { readyKind: 'port', readyValue: '5173' })
    const change = saveChange(draft, project())
    expect(change).toMatchObject({ layer: 'shared', projectRoot: ROOT })
    if (change.layer !== 'shared') throw new Error('shared')
    expect(change.setup.steps.find((s) => s.id === 'app')?.ready).toEqual({ kind: 'port', port: 5173 })
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

  it('orders steps of different projects in one list, and writes runsIn for Everyone', () => {
    let draft = startDraft(project({ setup: null }), 'shared')
    draft = addStep(draft, { name: 'temporal', command: 'temporal server start-dev', runsIn: 'jupiter-core' })
    draft = addStep(draft, { name: 'app', command: 'npm run dev', runsIn: 'jupiter-app' })
    draft = changeStep(draft, 'app', { start: 'after-previous' })
    draft = addStep(draft, { name: 'api', command: 'uv run api', runsIn: 'jupiter' })
    draft = moveStep(draft, 'api', 1)
    const change = saveChange(draft, project({ setup: null }))
    if (change.layer !== 'shared') throw new Error('shared')
    expect(change.setup.steps.map((step) => [step.id, step.runsIn])).toEqual([
      ['temporal', 'jupiter-core'],
      ['api', undefined],
      ['app', 'jupiter-app'],
    ])
  })

  it('moving a step to another project is a change; a tweak layer cannot do it', () => {
    const cross = project()
    let draft = startDraft(cross, 'shared')
    draft = changeStep(draft, 'temporal', { runsIn: 'jupiter-core' })
    expect(diffDraft(draft).changed.map((step) => step.id)).toEqual(['temporal'])
    draft = changeStep(draft, 'temporal', { runsIn: 'JUPITER' })
    expect(draft.steps[0]?.runsIn).toBeNull()
    const personal = startDraft(cross, 'personal')
    expect(changeStep(personal, 'temporal', { runsIn: 'jupiter-core' })).toBe(personal)
  })

  it('offers the setup\'s own project first, then the others, and keeps a project that is not here', () => {
    const draft = startDraft(project(), 'shared')
    expect(runsInChoices(draft, places, { runsIn: null }).map((choice) => choice.value)).toEqual(['', 'jupiter-core', 'jupiter-app'])
    const lost = runsInChoices(draft, places, { runsIn: 'billing' })
    expect(lost[lost.length - 1]).toEqual({ value: 'billing', label: 'billing · not on this computer', missing: true })
  })

  it('names the Starts choice after the step above: After X, or When X is ready', () => {
    const draft = startDraft(project(), 'shared')
    expect(startsOptions(draft.steps, 0)).toEqual([
      { value: 'now', label: 'Right away', disabled: false },
      { value: 'after-previous', label: 'After the step above', disabled: true },
    ])
    // temporal has a ready check; worker has none.
    expect(startsOptions(draft.steps, 1)[1]?.label).toBe('When temporal is ready')
    expect(startsOptions(draft.steps, 2)[1]?.label).toBe('After worker')
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
    const offered = offeredSuggestions(startDraft(project(), 'shared'), found)
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
    const offered = offeredSuggestions(startDraft(project(), 'shared'), found)
    expect(offered.groups.map((group) => [group.projectName, group.items.length])).toEqual([
      ['jupiter-app', 2],
      ['jupiter-core', 3],
    ])
  })

  it('a suggestion added in this draft says which step it became', () => {
    const draft = addSuggestion(startDraft(project(), 'shared'), found[1]!)
    const offered = offeredSuggestions(draft, found)
    const kafka = offered.top.find((item) => item.suggestion.command === 'docker compose up kafka')
    expect(kafka?.addedAs).toBe(5)
    expect(addedAsLabel(5)).toBe('Added as step 5')
    expect(draft.steps[4]).toMatchObject({ runsIn: 'jupiter-core', command: 'docker compose up kafka' })
  })

  it('a suggestion whose name is taken gets its project added', () => {
    const draft = addSuggestion(startDraft(project(), 'shared'), s('jupiter-core', 'npm run app'))
    expect(draft.steps[4]?.name).toBe('app (jupiter-core)')
  })
})

describe('tweak layers (Just me / This conversation)', () => {
  it('cannot add, rename or reorder; remove skips instead', () => {
    let draft = startDraft(project(), 'personal')
    expect(addStep(draft, { name: 'x' })).toBe(draft)
    expect(moveStep(draft, 'app', 0)).toBe(draft)
    expect(changeStep(draft, 'app', { name: 'web' })).toBe(draft)
    draft = removeStep(draft, 'app')
    expect(draft.steps.find((s) => s.id === 'app')?.skipped).toBe(true)
    expect(draft.removed).toEqual([])
  })

  it('writes only what differs from the layers below', () => {
    let draft = startDraft(project(), 'personal')
    draft = changeStep(draft, 'temporal', { readyKind: 'port', readyValue: '7300' })
    draft = removeStep(draft, 'app')
    expect(saveChange(draft, project())).toEqual({
      layer: 'personal',
      projectRoot: ROOT,
      tweaks: { temporal: { ready: { kind: 'port', port: 7300 } }, app: { skip: true } },
    })
  })

  it('a conversation sees the person’s tweaks and can undo a personal skip', () => {
    const layers = project({ personal: { app: { skip: true }, api: { command: 'uv run api --reload' } } })
    let draft = startDraft(layers, 'conversation')
    expect(draft.steps.find((s) => s.id === 'api')?.command).toBe('uv run api --reload')
    expect(draft.steps.find((s) => s.id === 'app')?.skipped).toBe(true)
    draft = removeStep(draft, 'app')
    expect(saveChange(draft, layers)).toEqual({ layer: 'conversation', projectRoot: ROOT, tweaks: { app: { skip: false } } })
  })

  it('removing a ready check writes null, and an unchanged step drops its old tweak', () => {
    const layers = project({ personal: { worker: { command: 'uv run worker' } } })
    let draft = startDraft(layers, 'personal')
    draft = changeStep(draft, 'temporal', { readyKind: 'none' })
    const change = saveChange(draft, layers)
    expect(change).toEqual({ layer: 'personal', projectRoot: ROOT, tweaks: { temporal: { ready: null } } })
  })

  it('keeps tweaks for steps the shared setup no longer names', () => {
    const layers = project({ personal: { gone: { skip: true } } })
    const change = saveChange(startDraft(layers, 'personal'), layers)
    expect(change).toEqual({ layer: 'personal', projectRoot: ROOT, tweaks: { gone: { skip: true } } })
  })
})

describe('validateDraft', () => {
  it('an untouched empty row is not a problem, and is not a change', () => {
    const draft = addStep(startDraft(project({ setup: { version: 1, steps: [] } }), 'shared'))
    expect(validateDraft(draft, { hasConversation: true })).toEqual([])
    expect(isDirty(draft)).toBe(false)
  })

  it('a step with a command and no name is named from the command on Save', () => {
    let draft = addStep(startDraft(project({ setup: { version: 1, steps: [] } }), 'shared'))
    draft = changeStep(draft, draft.steps[0]!.id, { command: 'npm run dev' })
    draft = addStep(draft)
    expect(validateDraft(draft, { hasConversation: true })).toEqual([])
    const change = saveChange(draft, project({ setup: { version: 1, steps: [] } }))
    expect(change.layer === 'shared' ? change.setup.steps.map((step) => [step.name, step.command]) : null).toEqual([
      ['dev', 'npm run dev'],
    ])
  })

  it('names each problem in plain words', () => {
    let draft = startDraft(project(), 'shared')
    draft = addStep(draft)
    const blankId = draft.steps[draft.steps.length - 1]!.id
    draft = changeStep(draft, blankId, { name: 'cache' })
    draft = changeStep(draft, 'app', { name: 'api' })
    draft = changeStep(draft, 'temporal', { readyValue: 'abc' })
    draft = changeStep(draft, 'worker', { readyKind: 'line', readyValue: ' ' })
    expect(validateDraft(draft, { hasConversation: true })).toEqual([
      '“temporal” waits for a port, but “abc” is not a port number.',
      '“worker” waits for a line, but the text to wait for is empty.',
      '“cache” needs a command to run.',
      'Two steps are called “api”. Give each its own name.',
    ])
  })

  it('the first step cannot wait for a step above it', () => {
    const draft = moveStep(startDraft(project(), 'shared'), 'worker', 0)
    expect(validateDraft(draft, { hasConversation: true })).toEqual([
      '“worker” is the first step, so it has no step to wait for. Set it to start right away.',
    ])
  })

  it('refuses This conversation without a conversation', () => {
    expect(validateDraft(startDraft(project(), 'conversation'), { hasConversation: false })).toHaveLength(1)
    expect(validateDraft(startDraft(project(), 'shared'), { hasConversation: false })).toEqual([])
  })
})

describe('saveSentence', () => {
  it('says nothing changed for an untouched draft', () => {
    expect(saveSentence(startDraft(project(), 'shared'), ALL_RUNNING)).toBe('Nothing has changed yet.')
  })

  it('reads like the mockup when one step is added to a going Run', () => {
    const draft = addSuggestion(startDraft(project(), 'shared'), {
      projectRoot: ROOT,
      projectName: 'jupiter-app',
      name: 'storybook',
      command: 'npm run storybook',
      source: 'package.json',
    })
    expect(saveSentence(draft, ALL_RUNNING)).toBe(
      'Saving starts the new step. The four running ones keep running. Everyone working on this project gets the change.',
    )
  })

  it('names a restart and a stop, and counts the rest', () => {
    let draft = startDraft(project(), 'shared')
    draft = changeStep(draft, 'api', { command: 'uv run api --reload' })
    draft = removeStep(draft, 'app')
    expect(saveSentence(draft, ALL_RUNNING)).toBe(
      'Saving restarts “api” and stops “app”. The two other running ones keep running. Everyone working on this project gets the change.',
    )
  })

  it('says nothing starts until Run when no Run is going', () => {
    const draft = removeStep(startDraft(project(), 'personal'), 'app')
    expect(saveSentence(draft, null)).toBe('Saving keeps the new setup; nothing starts until you press Run. Only on this computer.')
  })
})

describe('startsLabel', () => {
  it('says when a step starts and when it is ready', () => {
    const draft = startDraft(project(), 'shared')
    expect(startsLabel(draft.steps, 0)).toBe('right away · ready on port 7233')
    expect(startsLabel(draft.steps, 1)).toBe('when temporal is ready')
    expect(startsLabel(draft.steps, 2)).toBe('after worker')
  })
})

describe('UI text (forbidden-pattern #12)', () => {
  it('no sentence the panel composes names a path, a setting or a command line', () => {
    let draft = startDraft(project(), 'shared')
    draft = addStep(draft)
    draft = changeStep(draft, 'temporal', { readyValue: '' })
    draft = removeStep(draft, 'app')
    const sentences = [
      ...validateDraft(draft, { hasConversation: false }),
      saveSentence(draft, ALL_RUNNING),
      saveSentence(draft, null),
      saveSentence(removeStep(startDraft(project(), 'conversation'), 'api'), ALL_RUNNING),
      ...validateDraft(moveStep(startDraft(project(), 'shared'), 'worker', 0), { hasConversation: true }),
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
    const draft = changeStep(startDraft(layers, 'shared'), 'worker', { skipped: true })
    const change = saveChange(draft, layers)
    const steps = change.layer === 'shared' ? change.setup.steps : []
    expect(steps.map((step) => step.id)).toContain('worker')
    expect(steps.find((step) => step.id === 'worker')?.disabled).toBe(true)
    expect(steps.find((step) => step.id === 'api')?.disabled).toBeUndefined()
    const reread = startDraft(project({ setup: change.layer === 'shared' ? change.setup : null }), 'shared')
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
  const empty = (): RunSetupDraft => addStep(startDraft(project({ setup: { version: 1, steps: [] } }), 'shared'))

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
