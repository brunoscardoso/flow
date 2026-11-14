import type { RunGroupState, RunProjectLayers, RunStepStatus } from '../../shared/run-setup'
import {
  addStep,
  addSuggestion,
  changeStep,
  diffDraft,
  draftFromSuggestions,
  isDirty,
  moveStep,
  otherProjectsSentence,
  removeStep,
  saveChange,
  saveSentence,
  startDraft,
  startsLabel,
  validateDraft,
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

  it('starts from the suggestions the person ticked', () => {
    const draft = draftFromSuggestions({ root: ROOT, name: 'jupiter' }, [
      { projectRoot: ROOT, projectName: 'jupiter-app', name: 'dev', command: 'npm run dev', source: 'package.json' },
    ])
    expect(draft.steps).toHaveLength(1)
    expect(draft.steps[0]).toMatchObject({ name: 'dev', command: 'npm run dev', origin: 'jupiter-app · package.json', isNew: true })
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
  it('names each problem in plain words', () => {
    let draft = startDraft(project(), 'shared')
    draft = addStep(draft)
    draft = changeStep(draft, 'app', { name: 'api' })
    draft = changeStep(draft, 'temporal', { readyValue: 'abc' })
    draft = changeStep(draft, 'worker', { readyKind: 'line', readyValue: ' ' })
    expect(validateDraft(draft, { hasConversation: true })).toEqual([
      '“temporal” waits for a port, but “abc” is not a port number.',
      '“worker” waits for a line, but the text to wait for is empty.',
      'Step 5 needs a name.',
      'Step 5 needs a command to run.',
      'Two steps are called “api”. Give each its own name.',
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

describe('otherProjectsSentence', () => {
  it('names the other projects a Save also writes', () => {
    expect(otherProjectsSentence([])).toBeNull()
    expect(otherProjectsSentence(['a', 'b', 'c'])).toBe('Your changes to a, b and c are saved too.')
  })
})

describe('startsLabel', () => {
  it('says when a step starts and when it is ready', () => {
    const draft = startDraft(project(), 'shared')
    expect(startsLabel(draft.steps, 0)).toBe('right away · ready on port 7233')
    expect(startsLabel(draft.steps, 1)).toBe('after temporal')
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
    ]
    for (const text of sentences) {
      expect(text).not.toMatch(/planflow-ai|`|flow\/|setup\.json|\.json\b|\b[a-z]+_[a-z_]+\b|(^|\s)--?[a-z]/)
    }
  })
})
