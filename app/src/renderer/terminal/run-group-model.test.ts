import type {
  ResolvedRunStep,
  RunGroupState,
  RunOnceState,
  RunStepState,
  RunStepStatus,
  RunSuggestion,
  RunView,
} from '../../shared/run-setup'
import {
  askAgentPrompt,
  durationLabel,
  groupHasRun,
  launchpadMenu,
  launchpadMenuEntries,
  moveMenuFocus,
  onceAsk,
  onceOfTerminal,
  onceTabFace,
  orderRunTabs,
  pendingTabAction,
  pendingTabId,
  pendingTabTooltip,
  pillFace,
  RUN_STRINGS,
  stepKeyOfPendingTab,
  stepOfTerminal,
  stepTabFace,
} from './run-group-model'
import { parseRunSetup } from '../../shared/run-setup'
import { SETUP_STRINGS, setupTitle } from './run-setup-model'

const ROOT = '/work/jupiter'

function step(name: string, status: RunStepStatus, extra: Partial<RunStepState> = {}): RunStepState {
  return {
    key: `${ROOT}::${name}`,
    name,
    projectRoot: ROOT,
    status,
    terminalId: status === 'idle' || status === 'waiting' ? null : `t-${name}`,
    exitCode: null,
    detail: null,
    ...extra,
  }
}

function group(steps: RunStepState[], active = false): RunGroupState {
  return { scopeKey: `${ROOT}::thread-1`, active, steps }
}

function view(steps: RunStepState[], active = false, setupCount = steps.length): RunView {
  return {
    resolution: {
      scope: { rootPath: ROOT, threadId: 'thread-1' },
      scopeKey: `${ROOT}::thread-1`,
      project: { root: ROOT, name: 'jupiter', cwd: ROOT, setup: null, personal: {}, conversation: {}, hasSharedSetup: false, problems: [] },
      places: [],
      steps: Array.from({ length: setupCount }, (_, i) => ({
        key: `${ROOT}::s${i}`,
        projectRoot: ROOT,
        projectName: 'jupiter',
        cwd: ROOT,
        id: `s${i}`,
        name: `s${i}`,
        command: 'npm run dev',
        start: 'now' as const,
        readyTimeoutMs: 60_000,
        from: { command: 'shared' as const, ready: 'shared' as const },
      })),
    },
    state: group(steps, active),
  }
}

function onceStep(name: string, extra: Partial<ResolvedRunStep> = {}): ResolvedRunStep {
  return {
    key: `${ROOT}::${name}`,
    projectRoot: ROOT,
    projectName: 'jupiter',
    cwd: ROOT,
    id: name,
    name,
    command: `npm run ${name}`,
    start: 'now',
    readyTimeoutMs: 60_000,
    from: { command: 'shared', ready: 'shared' },
    kind: 'once',
    ...extra,
  }
}

function onceState(name: string, extra: Partial<RunOnceState> = {}): RunOnceState {
  return {
    key: `${ROOT}::${name}`,
    name,
    projectRoot: ROOT,
    projectName: 'jupiter',
    status: 'running',
    terminalId: `o-${name}`,
    exitCode: null,
    durationMs: null,
    ...extra,
  }
}

function withOnce(base: RunView, once: ResolvedRunStep[], live: RunOnceState[] = []): RunView {
  return {
    resolution: { ...base.resolution, once },
    state: { ...base.state, ...(live.length > 0 ? { once: live } : {}) },
  }
}

describe('pillFace', () => {
  it('hides without a view and offers Set up Launchpad for a scope with no steps', () => {
    expect(pillFace(null).mode).toBe('hidden')
    expect(pillFace(view([], false, 0)).mode).toBe('set-up')
  })

  it('counts running, waiting and failed steps while a Run is going', () => {
    const face = pillFace(
      view(
        [step('temporal', 'ready'), step('worker', 'running'), step('api', 'waiting'), step('app', 'exited', { exitCode: 1 })],
        true,
      ),
    )
    expect(face).toMatchObject({ mode: 'going', summary: '2 running · 1 waiting · 1 failed', canStop: true, canRun: false })
    expect(face.summaryTitle).toBe('One step is waiting, one step has stopped with a problem.')
  })

  it('reads 4 running like the mockup', () => {
    const face = pillFace(view(['a', 'b', 'c', 'd'].map((n) => step(n, 'running')), true))
    expect(face.summary).toBe('4 running')
  })

  it('says how many steps a setup has before the first Run, and Stopped after a Stop', () => {
    expect(pillFace(view([step('a', 'idle'), step('b', 'idle')]))).toMatchObject({ mode: 'ready', summary: '2 steps', canRun: true })
    expect(pillFace(view([step('a', 'stopped'), step('b', 'stopped')]))).toMatchObject({
      mode: 'stopped',
      summary: 'Stopped',
      canRun: true,
      canReload: true,
    })
  })
})

describe('stepTabFace', () => {
  it('labels a running step by its name alone', () => {
    expect(stepTabFace(step('api', 'running'))).toMatchObject({ label: 'api', tone: 'ok', pending: false })
  })

  it('says what a waiting step waits for, from main', () => {
    const face = stepTabFace(step('api', 'waiting', { detail: 'Waiting for port 7233 to answer.' }))
    expect(face).toMatchObject({ label: 'api · waiting', tone: 'busy', tooltip: 'Waiting for port 7233 to answer.' })
  })

  it('draws a set-up step that has not started as pending', () => {
    expect(stepTabFace(step('storybook', 'idle'))).toMatchObject({ label: 'storybook · not started', pending: true })
  })

  it('names an exit code and tells a clean finish from a failure', () => {
    expect(stepTabFace(step('a', 'exited', { exitCode: 2 }))).toMatchObject({ label: 'a · ended (2)', tone: 'bad' })
    expect(stepTabFace(step('a', 'exited', { exitCode: 0 }))).toMatchObject({ label: 'a · finished', tone: 'off' })
    expect(stepTabFace(step('a', 'blocked')).label).toBe('a · port busy')
    expect(stepTabFace(step('a', 'timed-out')).label).toBe('a · not ready')
  })
})

describe('pending tabs', () => {
  it('starts the whole Run before a first Run, and only that step after', () => {
    const idle = step('s', 'idle')
    expect(pendingTabAction(idle, group([idle]))).toBe('start-run')
    expect(pendingTabAction(idle, group([idle, step('t', 'running')], true))).toBe('reload-step')
    expect(pendingTabAction(step('w', 'waiting'), group([step('t', 'running')], true))).toBe('none')
    expect(pendingTabTooltip(idle, group([idle]))).toBe(RUN_STRINGS.startRunTitle)
  })

  it('round-trips a pending tab id', () => {
    expect(stepKeyOfPendingTab(pendingTabId(`${ROOT}::api`))).toBe(`${ROOT}::api`)
    expect(stepKeyOfPendingTab('term-3')).toBeNull()
  })
})

describe('orderRunTabs (note 9)', () => {
  const tabs = ['plain-1', 't-app', 'plain-2', 't-temporal']

  it('puts the Run steps first in step order, then plain tabs unchanged', () => {
    const state = group([step('temporal', 'running'), step('storybook', 'idle'), step('app', 'running')], true)
    const ordered = orderRunTabs(tabs, (t) => t, state)
    expect(ordered.map((o) => (o.kind === 'pending' ? `pending:${o.step.name}` : `${o.kind}:${o.item}`))).toEqual([
      'step:t-temporal',
      'pending:storybook',
      'step:t-app',
      'plain:plain-1',
      'plain:plain-2',
    ])
  })

  it('a step whose tab the person closed is gone, not a "stopped" placeholder', () => {
    const closed = { ...step('storybook', 'stopped'), terminalId: null }
    const state = group([step('temporal', 'running'), closed], true)
    const ordered = orderRunTabs(tabs, (t) => t, state)
    expect(ordered.some((o) => o.kind === 'pending')).toBe(false)
    expect(ordered[0]).toMatchObject({ kind: 'step', item: 't-temporal' })
  })

  it('leaves plain terminals exactly as they were without a Run', () => {
    expect(orderRunTabs(tabs, (t) => t, null).map((o) => o.kind)).toEqual(['plain', 'plain', 'plain', 'plain'])
    expect(groupHasRun(null)).toBe(false)
  })

  it('finds the step a terminal runs', () => {
    const state = group([step('app', 'running')], true)
    expect(stepOfTerminal(state, 't-app')?.name).toBe('app')
    expect(stepOfTerminal(state, 'plain-1')).toBeNull()
  })
})

describe('asking the agent', () => {
  const found: RunSuggestion[] = [
    { projectRoot: '/work/app', projectName: 'jupiter-app', name: 'dev', command: 'npm run dev', source: 'package.json' },
  ]

  it('asks the agent to propose, not to start anything, naming where steps may run', () => {
    const prompt = askAgentPrompt('jupiter', found, ['jupiter', 'jupiter-core', 'jupiter-app'])
    expect(prompt).toContain('Do not start anything')
    expect(prompt).toContain('the project it runs in')
    expect(prompt).toContain('A step can also run in jupiter-core, jupiter-app.')
    expect(prompt).toContain('- npm run dev (jupiter-app, package.json)')
  })
})

describe('a step whose project is not on this computer', () => {
  it("says it can't start, and clicking its tab after a Run does nothing", () => {
    const lost = step('temporal', 'blocked', { terminalId: null, notHere: true, detail: "jupiter-core is not on this computer, so this step can't start." })
    expect(stepTabFace(lost)).toMatchObject({ label: "temporal · can't start", tone: 'bad', tooltip: lost.detail })
    expect(pendingTabAction(lost, group([lost]))).toBe('none')
  })
})

// ─── forbidden-pattern #12: no command, path or setting in UI text ───────────

const FORBIDDEN: Array<[string, RegExp]> = [
  ['the CLI', /planflow-ai|plan-flow/i],
  ['a backtick', /`/],
  ['a Flow folder path', /\bflow\/|\/flow\b/],
  ['the setup file', /setup\.json|\brun\//],
  ['a file extension', /\.(json|md|ts|ya?ml|flowconfig)\b/],
  ['a flag', /(^|\s)--?[a-z]/],
  ['a config key', /\b[a-z]+_[a-z_]+\b|\b[a-z]+:\s*(true|false)\b/],
  ['an absolute path', /(^|\s)\/[a-z]/i],
]

function uiStrings(): string[] {
  const all: string[] = [
    ...Object.values(RUN_STRINGS),
    ...Object.values(SETUP_STRINGS),
    setupTitle([{ name: 'jupiter-app' }, { name: 'jupiter-core' }]),
  ]
  const statuses: RunStepStatus[] = ['idle', 'waiting', 'starting', 'running', 'ready', 'exited', 'stopped', 'blocked', 'timed-out']
  for (const status of statuses) {
    const s = step('api', status, { exitCode: status === 'exited' ? 1 : null })
    const face = stepTabFace(s)
    all.push(face.label, face.tooltip, pendingTabTooltip(s, group([s])))
  }
  for (const v of [view([], false, 0), view([step('a', 'running'), step('b', 'waiting'), step('c', 'blocked')], true), view([step('a', 'stopped')])]) {
    const face = pillFace(v)
    if (face.summary !== null) all.push(face.summary)
    all.push(face.summaryTitle)
  }
  all.push(stepTabFace(step('x', 'blocked', { notHere: true })).label, stepTabFace(step('x', 'blocked', { notHere: true })).tooltip)
  // The Launchpad menu, a one-time action's tab and the ask before it runs.
  for (const live of [
    onceState('migrate'),
    onceState('migrate', { status: 'exited', exitCode: 0, durationMs: 2_400 }),
    onceState('migrate', { status: 'exited', exitCode: 1, durationMs: 75_000 }),
    onceState('migrate', { status: 'exited', exitCode: null, durationMs: null }),
    onceState('migrate', { status: 'stopped' }),
  ]) {
    const face = onceTabFace(live)
    all.push(face.label, face.tooltip)
  }
  const menuViews = [
    view([], false, 0),
    withOnce(view([step('a', 'running')], true), [onceStep('migrate', { confirm: true }), onceStep('seed', { unavailable: "jupiter-core is not on this computer, so this step can't start." })], [onceState('migrate')]),
    withOnce(view([step('a', 'idle')]), [onceStep('gen')]),
  ]
  for (const v of menuViews) {
    const menu = launchpadMenu(v)
    all.push(menu.runAll.title)
    for (const group of menu.groups) for (const item of group.items) all.push(item.title)
  }
  const ask = onceAsk(onceStep('migrate'))
  all.push(ask.title, ask.where, onceAsk(onceStep('migrate', { cwd: '/work/.jupiter-threads/blue' })).where)
  // The sentence the page shows for a stored entry of a kind this build can't run.
  all.push(...parseRunSetup(JSON.stringify({ version: 1, steps: [{ name: 'x', command: 'y', kind: 'later' }] })).problems)
  return all.filter((text) => text !== '')
}

describe('UI text (forbidden-pattern #12)', () => {
  it('names no command line, path or setting', () => {
    const offenders: string[] = []
    for (const text of uiStrings()) {
      for (const [what, pattern] of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${what}: ${text}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the scan catches what it is meant to catch', () => {
    const bad = ['run `planflow-ai init`', 'edit flow/run/setup.json', 'set remote_branch_pattern', 'pass --force']
    for (const text of bad) expect(FORBIDDEN.some(([, pattern]) => pattern.test(text))).toBe(true)
  })
})

describe('the Launchpad menu', () => {
  it('groups the turned-on one-time actions by project, with the command, asks first and running', () => {
    const v = withOnce(
      view([step('web', 'idle')]),
      [
        onceStep('migrate', { confirm: true, projectName: 'jupiter-core', projectRoot: '/work/core' }),
        onceStep('codegen'),
        onceStep('seed', { projectName: 'jupiter-core', projectRoot: '/work/core' }),
      ],
      [onceState('codegen')],
    )
    const menu = launchpadMenu(v)
    expect(menu.empty).toBe(false)
    expect(menu.groups.map((group) => [group.projectName, group.items.map((item) => item.name)])).toEqual([
      ['jupiter-core', ['migrate', 'seed']],
      ['jupiter', ['codegen']],
    ])
    expect(menu.groups[0]!.items[0]).toMatchObject({ command: 'npm run migrate', asksFirst: true, running: false, disabled: false })
    expect(menu.groups[1]!.items[0]).toMatchObject({ running: true, title: RUN_STRINGS.onceRunningTitle })
    expect(menu.runAll).toEqual({ shown: true, disabled: false, title: RUN_STRINGS.runTitle })
    expect(launchpadMenuEntries(menu)).toEqual([
      { kind: 'once', key: '/work/jupiter::migrate' },
      { kind: 'once', key: '/work/jupiter::seed' },
      { kind: 'once', key: '/work/jupiter::codegen' },
      { kind: 'run-all' },
      { kind: 'edit' },
    ])
  })

  it('with no actions it says so and offers to add one; Run all is disabled while steps run and hidden without steps', () => {
    const going = launchpadMenu(view([step('web', 'running')], true))
    expect(going.empty).toBe(true)
    expect(going.runAll).toEqual({ shown: true, disabled: true, title: RUN_STRINGS.runAllGoing })
    expect(launchpadMenuEntries(going)).toEqual([{ kind: 'add' }, { kind: 'edit' }])
    const actionsOnly = launchpadMenu(withOnce(view([], false, 0), [onceStep('migrate')]))
    expect(actionsOnly.runAll.shown).toBe(false)
    expect(launchpadMenuEntries(actionsOnly)).toEqual([{ kind: 'once', key: '/work/jupiter::migrate' }, { kind: 'edit' }])
    expect(launchpadMenu(null)).toMatchObject({ empty: true, groups: [], runAll: { shown: false } })
  })

  it('an action whose project is not here is shown disabled with the reason, and skipped by the keyboard', () => {
    const reason = "jupiter-core is not on this computer, so this step can't start."
    const menu = launchpadMenu(withOnce(view([], false, 0), [onceStep('seed', { unavailable: reason })]))
    expect(menu.groups[0]!.items[0]).toMatchObject({ disabled: true, title: reason })
    expect(launchpadMenuEntries(menu)).toEqual([{ kind: 'edit' }])
  })

  it('arrow keys move and wrap; Home and End jump', () => {
    expect(moveMenuFocus(-1, 3, 'ArrowDown')).toBe(0)
    expect(moveMenuFocus(-1, 3, 'ArrowUp')).toBe(2)
    expect(moveMenuFocus(2, 3, 'ArrowDown')).toBe(0)
    expect(moveMenuFocus(0, 3, 'ArrowUp')).toBe(2)
    expect(moveMenuFocus(1, 3, 'Home')).toBe(0)
    expect(moveMenuFocus(1, 3, 'End')).toBe(2)
    expect(moveMenuFocus(0, 0, 'ArrowDown')).toBe(-1)
  })

  it('Run all and pill counts never include a one-time action', () => {
    const v = withOnce(view([step('web', 'idle')]), [onceStep('migrate'), onceStep('seed')], [onceState('migrate')])
    expect(pillFace(v)).toMatchObject({ mode: 'ready', summary: '1 step', canRun: true, canStop: false })
  })
})

describe('the ask before a one-time action runs', () => {
  it('names the action, the project and its checkout or folder, and shows the command', () => {
    expect(onceAsk(onceStep('migrate', { cwd: '/work/.jupiter-threads/blue', command: 'uv run alembic upgrade head' }))).toEqual({
      title: 'Run “migrate”?',
      where: "This runs in jupiter, in this conversation's checkout:",
      command: 'uv run alembic upgrade head',
    })
    expect(onceAsk(onceStep('migrate')).where).toBe('This runs in jupiter, in its folder:')
  })
})

describe('a one-time action’s tab', () => {
  it('reads running, then finished with how long, or ended with its code', () => {
    expect(onceTabFace(onceState('migrate'))).toMatchObject({ label: 'migrate · running', tone: 'busy', finished: false })
    expect(onceTabFace(onceState('migrate', { status: 'exited', exitCode: 0, durationMs: 2_400 }))).toEqual({
      label: 'migrate · finished',
      tone: 'ok',
      finished: true,
      tooltip: 'Finished in 2.4 s.',
    })
    expect(onceTabFace(onceState('migrate', { status: 'exited', exitCode: 2, durationMs: 12_000 }))).toMatchObject({
      label: 'migrate · ended (2)',
      tone: 'bad',
      tooltip: 'Ended with code 2 after 12 s.',
    })
  })

  it('says durations plainly', () => {
    expect(durationLabel(0)).toBe('0.0 s')
    expect(durationLabel(2_449)).toBe('2.4 s')
    expect(durationLabel(42_000)).toBe('42 s')
    expect(durationLabel(185_000)).toBe('3 min 5 s')
    expect(durationLabel(120_000)).toBe('2 min')
  })

  it('stands after the running steps and before plain tabs, and is found by its terminal', () => {
    const state: RunGroupState = { ...group([step('web', 'running')], true), once: [onceState('migrate'), onceState('gone', { terminalId: 'missing' })] }
    const ordered = orderRunTabs(['plain-1', 'o-migrate', 't-web'], (t) => t, state)
    expect(ordered.map((o) => (o.kind === 'pending' ? 'pending' : `${o.kind}:${o.item}`))).toEqual(['step:t-web', 'once:o-migrate', 'plain:plain-1'])
    expect(onceOfTerminal(state, 'o-migrate')?.name).toBe('migrate')
    expect(stepOfTerminal(state, 'o-migrate')).toBeNull()
    // Actions alone (no running steps) still order their tabs.
    const onlyOnce: RunGroupState = { scopeKey: 'k', active: false, steps: [], once: [onceState('migrate')] }
    expect(orderRunTabs(['plain-1', 'o-migrate'], (t) => t, onlyOnce).map((o) => o.kind)).toEqual(['once', 'plain'])
  })
})
