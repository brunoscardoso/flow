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
  DOCKER_STRINGS,
  dockerMenuGroup,
  switchSentence,
  dockerNoticeFace,
  splitDetail,
  stoppedRightAwayFace,
  askAgentPrompt,
  durationLabel,
  groupHasRun,
  launchpadMenu,
  launchpadMenuEntries,
  linesLabel,
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

const ROOT = '/work/lumen'

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
      project: { root: ROOT, name: 'lumen', cwd: ROOT, setup: null, personal: {}, conversation: {}, hasSharedSetup: false, problems: [] },
      places: [],
      steps: Array.from({ length: setupCount }, (_, i) => ({
        key: `${ROOT}::s${i}`,
        projectRoot: ROOT,
        projectName: 'lumen',
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
    projectName: 'lumen',
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
    projectName: 'lumen',
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
    { projectRoot: '/work/app', projectName: 'lumen-app', name: 'dev', command: 'npm run dev', source: 'package.json' },
  ]

  it('asks the agent to propose, not to start anything, naming where steps may run', () => {
    const prompt = askAgentPrompt('lumen', found, ['lumen', 'lumen-core', 'lumen-app'])
    expect(prompt).toContain('Do not start anything')
    expect(prompt).toContain('the project it runs in')
    expect(prompt).toContain('A step can also run in lumen-core, lumen-app.')
    expect(prompt).toContain('- npm run dev (lumen-app, package.json)')
  })
})

describe('a step whose project is not on this computer', () => {
  it("says it can't start, and clicking its tab after a Run does nothing", () => {
    const lost = step('temporal', 'blocked', { terminalId: null, notHere: true, detail: "lumen-core is not on this computer, so this step can't start." })
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
    ...Object.values(DOCKER_STRINGS),
    ...Object.values(SETUP_STRINGS),
    setupTitle([{ name: 'lumen-app' }, { name: 'lumen-core' }]),
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
    withOnce(view([step('a', 'running')], true), [onceStep('migrate', { confirm: true }), onceStep('seed', { unavailable: "lumen-core is not on this computer, so this step can't start." })], [onceState('migrate')]),
    withOnce(view([step('a', 'idle')]), [onceStep('gen')]),
  ]
  for (const v of menuViews) {
    const menu = launchpadMenu(v)
    all.push(menu.runAll.title)
    for (const group of menu.groups) for (const item of group.items) all.push(item.title)
  }
  const ask = onceAsk(onceStep('migrate'))
  const scriptAsk = onceAsk(onceStep('reset', { body: 'script', command: 'set -e\ndocker compose down -v' }))
  all.push(scriptAsk.where, scriptAsk.run, linesLabel(1), linesLabel(12))
  all.push(ask.title, ask.where, onceAsk(onceStep('migrate', { cwd: '/work/.lumen-threads/blue' })).where)
  // The sentence the page shows for a stored entry of a kind this build can't run.
  all.push(...parseRunSetup(JSON.stringify({ version: 1, steps: [{ name: 'x', command: 'y', kind: 'later' }] })).problems)
  // The Docker group's rows and notices.
  const dv = dockerView([dockerStep('db', 'running'), dockerStep('api', 'exited', { exitCode: 1, offerReset: true, detail: 'This service stopped right after starting. Its last lines:\nFATAL: bad' })], {
    dockerNotices: [
      { projectRoot: null, kind: 'docker-unavailable', detail: "Docker isn't running." },
      { projectRoot: null, kind: 'port-clash', detail: 'api and billing both use port 5432 on this computer, so this conversation\'s services can\'t start together.' },
    ],
    offerOpenDocker: true,
  })
  const docker = dockerMenuGroup(dv)
  // The section before its services go: Start Docker, and Switch to this thread (known title, and not).
  for (const elsewhere of [null, { threadId: 'thread-2', title: 'Invoice export' }, { threadId: 'thread-2', title: null }]) {
    const face = dockerMenuGroup(dockerView([dockerStep('db', 'idle')]), elsewhere)
    all.push(face?.sentence ?? '', face?.primary?.label ?? '', face?.primary?.title ?? '')
  }
  for (const row of docker?.services ?? []) all.push(row.note, row.title)
  for (const notice of docker?.notices ?? []) all.push(notice.title ?? '', notice.sentence)
  return all.filter((text) => text !== '')
}

function dockerStep(name: string, status: RunStepStatus, extra: Partial<RunStepState> = {}): RunStepState {
  return step(name, status, { key: `${ROOT}::docker:${name}`, docker: { projectRoot: ROOT, service: name }, ...extra })
}

/** A view of a thread whose project keeps its own data: Docker steps first, then a local one. */
function dockerView(dockerSteps: RunStepState[], extra: Partial<RunGroupState> = {}, local: RunStepState[] = []): RunView {
  const base = view([...dockerSteps, ...local], dockerSteps.some((s) => s.status === 'running'), 0)
  const resolved = (s: RunStepState, port: number | null): ResolvedRunStep => ({
    key: s.key,
    projectRoot: ROOT,
    projectName: 'lumen',
    cwd: ROOT,
    id: s.key.split('::')[1]!,
    name: s.name,
    command: 'run it',
    start: 'now',
    readyTimeoutMs: 60_000,
    from: { command: 'shared', ready: 'shared' },
    ...(port === null ? {} : { ready: { kind: 'port' as const, port } }),
    ...(s.docker === undefined ? {} : { docker: s.docker }),
  })
  return {
    resolution: {
      ...base.resolution,
      steps: [...dockerSteps.map((s) => resolved(s, s.name === 'db' ? 5432 : null)), ...local.map((s) => resolved(s, 3000))],
      docker: [
        {
          projectRoot: ROOT,
          projectName: 'lumen',
          threadId: 'thread-1',
          checkout: ROOT,
          services: dockerSteps.map((s) => s.name),
          dataServices: ['db'],
          volumes: [],
          unreadable: [],
          folded: [],
          notes: [],
        },
      ],
    },
    state: { ...base.state, ...extra },
  }
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
        onceStep('migrate', { confirm: true, projectName: 'lumen-core', projectRoot: '/work/core' }),
        onceStep('codegen'),
        onceStep('seed', { projectName: 'lumen-core', projectRoot: '/work/core' }),
      ],
      [onceState('codegen')],
    )
    const menu = launchpadMenu(v)
    expect(menu.empty).toBe(false)
    expect(menu.groups.map((group) => [group.projectName, group.items.map((item) => item.name)])).toEqual([
      ['lumen-core', ['migrate', 'seed']],
      ['lumen', ['codegen']],
    ])
    expect(menu.groups[0]!.items[0]).toMatchObject({ command: 'npm run migrate', asksFirst: true, running: false, disabled: false })
    expect(menu.groups[1]!.items[0]).toMatchObject({ running: true, title: RUN_STRINGS.onceRunningTitle })
    expect(menu.runAll).toEqual({ shown: true, disabled: false, title: RUN_STRINGS.runTitle })
    expect(launchpadMenuEntries(menu)).toEqual([
      { kind: 'once', key: '/work/lumen::migrate' },
      { kind: 'once', key: '/work/lumen::seed' },
      { kind: 'once', key: '/work/lumen::codegen' },
      { kind: 'run-all' },
      { kind: 'edit' },
    ])
  })

  it('with no actions it says so and offers to add one; Run all is disabled while steps run and hidden without steps', () => {
    const going = launchpadMenu(view([step('web', 'running')], true))
    expect(going.empty).toBe(true)
    expect(going.runAll).toEqual({ shown: true, disabled: true, title: RUN_STRINGS.runAllGoing })
    // While steps run, Reload all and Stop all are in the menu (moved from the pill).
    expect(going).toMatchObject({ reloadAll: true, stopAll: true })
    expect(launchpadMenuEntries(going)).toEqual([{ kind: 'add' }, { kind: 'reload-all' }, { kind: 'stop-all' }, { kind: 'edit' }])
    const actionsOnly = launchpadMenu(withOnce(view([], false, 0), [onceStep('migrate')]))
    expect(actionsOnly.runAll.shown).toBe(false)
    expect(launchpadMenuEntries(actionsOnly)).toEqual([{ kind: 'once', key: '/work/lumen::migrate' }, { kind: 'edit' }])
    expect(launchpadMenu(null)).toMatchObject({ empty: true, groups: [], runAll: { shown: false } })
  })

  it('an action whose project is not here is shown disabled with the reason, and skipped by the keyboard', () => {
    const reason = "lumen-core is not on this computer, so this step can't start."
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
    expect(onceAsk(onceStep('migrate', { cwd: '/work/.lumen-threads/blue', command: 'uv run alembic upgrade head' }))).toEqual({
      title: 'Run “migrate”?',
      where: "This runs in lumen, in this conversation's checkout:",
      command: 'uv run alembic upgrade head',
      script: false,
      run: 'Run',
    })
    expect(onceAsk(onceStep('migrate')).where).toBe('This runs in lumen, in its folder:')
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

describe('scripts in the Launchpad menu and the ask', () => {
  const SCRIPT = Array.from({ length: 12 }, (_, i) => `echo line ${i + 1}`).join('\n')

  it('says "command" or "script · N lines" under each action', () => {
    const v = withOnce(view([step('web', 'idle')]), [onceStep('lint'), onceStep('reset', { body: 'script', command: SCRIPT }), onceStep('one', { body: 'script', command: 'echo hi' })])
    const items = launchpadMenu(v).groups[0]!.items
    expect(items.map((item) => [item.name, item.detail, item.script])).toEqual([
      ['lint', 'command', false],
      ['reset', 'script · 12 lines', true],
      ['one', 'script · 1 line', true],
    ])
  })

  it('shows the whole script before it runs, with "Run script"', () => {
    const ask = onceAsk(onceStep('reset', { body: 'script', command: SCRIPT }))
    expect(ask).toMatchObject({ script: true, run: 'Run script', command: SCRIPT, where: 'This script runs in lumen, in its folder:' })
  })
})

describe('the Run menu’s Docker section — its three faces', () => {
  const idle = (): RunView => dockerView([dockerStep('db', 'idle'), dockerStep('redis', 'idle'), dockerStep('api', 'idle')], {}, [step('web', 'idle')])

  it('not started: the services by name, what Start Docker does, and the button — no service rows or tools', () => {
    const group = dockerMenuGroup(idle())!
    expect(group).toMatchObject({
      mode: 'start',
      serviceNames: 'db, redis, api',
      sentence: "Starts this project's containers with this thread's own data.",
      primary: { label: 'Start Docker', icon: 'play' },
      liveHere: false,
      canStop: false,
    })
    // Run all still starts Docker and the local steps.
    const menu = launchpadMenu(idle())
    expect(menu.runAll).toMatchObject({ shown: true, disabled: false })
    expect(menu.local.map((row) => row.name)).toEqual(['web'])
  })

  it('another thread’s data runs: whose, by title, and Switch to this thread', () => {
    const group = dockerMenuGroup(idle(), { threadId: 'thread-2', title: 'Invoice export' })!
    expect(group).toMatchObject({
      mode: 'switch',
      sentence: "Running with the data of “Invoice export”. Switching stops it and starts this thread's data.",
      primary: { label: 'Switch to this thread', icon: 'sync' },
    })
    expect(launchpadMenu(idle(), { threadId: 'thread-2', title: 'Invoice export' }).docker?.mode).toBe('switch')
  })

  it('an unknown title reads as another thread; this thread’s own id is not a switch', () => {
    expect(dockerMenuGroup(idle(), { threadId: 'thread-2', title: null })!.sentence).toBe(
      "Running with the data of another thread. Switching stops it and starts this thread's data.",
    )
    expect(switchSentence('  ')).toBe(switchSentence(null))
    expect(dockerMenuGroup(idle(), { threadId: 'thread-1', title: 'Mine' })!.mode).toBe('start')
  })

  it('running: unchanged — the pill, service rows, Restart and Stop; no sentence or button, whatever runs elsewhere', () => {
    const v = dockerView([dockerStep('db', 'running'), dockerStep('redis', 'waiting')])
    const group = dockerMenuGroup(v, { threadId: 'thread-2', title: 'Invoice export' })!
    expect(group).toMatchObject({ mode: 'running', sentence: null, primary: null, liveHere: true, canReload: true, canStop: true, manage: true })
    expect(group.services.map((row) => row.name)).toEqual(['db', 'redis'])
  })

  it('a service still waiting to answer is running, not a reason to offer Start Docker again', () => {
    expect(dockerMenuGroup(dockerView([dockerStep('db', 'waiting')]))!.mode).toBe('running')
  })

  it('notices show before a start too (Docker not running offers Open Docker beside Start Docker)', () => {
    const v = dockerView([dockerStep('db', 'blocked', { detail: "Docker isn't running." })], {
      dockerNotices: [{ projectRoot: null, kind: 'docker-unavailable', detail: "Docker isn't running." }],
      offerOpenDocker: true,
    })
    const group = dockerMenuGroup(v)!
    expect(group.mode).toBe('start')
    expect(group.notices[0]).toMatchObject({ action: 'open-docker' })
  })

  it('no thread (the project itself): no Docker section at all', () => {
    const v = idle()
    v.resolution.scope = { rootPath: ROOT, threadId: null }
    expect(dockerMenuGroup(v)).toBeNull()
    expect(dockerMenuGroup(v, { threadId: 'thread-2', title: 'Invoice export' })).toBeNull()
    expect(launchpadMenu(v).docker).toBeNull()
  })
})

describe('the Run menu’s Docker group', () => {
  it('is absent when the thread keeps no data of its own', () => {
    expect(dockerMenuGroup(null)).toBeNull()
    expect(dockerMenuGroup(view([step('web', 'running')], true))).toBeNull()
    expect(launchpadMenu(view([step('web', 'running')], true))).toMatchObject({ docker: null, local: [] })
  })

  it('Run all stays available after Start Docker while local steps are idle, and turns off once they go', () => {
    const dockerOnly = launchpadMenu(dockerView([dockerStep('db', 'running')], { active: true }, [step('web', 'idle')]))
    expect(dockerOnly.runAll).toEqual({ shown: true, disabled: false, title: RUN_STRINGS.runTitle })
    const allGoing = launchpadMenu(dockerView([dockerStep('db', 'running')], { active: true }, [step('web', 'running')]))
    expect(allGoing.runAll).toEqual({ shown: true, disabled: true, title: RUN_STRINGS.runAllGoing })
  })

  it('services with their port or status; the pill only while this thread’s data runs', () => {
    const v = dockerView([dockerStep('db', 'running'), dockerStep('redis', 'starting')], {}, [step('web', 'running')])
    const group = dockerMenuGroup(v)!
    expect(group.liveHere).toBe(true)
    expect(group.services.map((row) => [row.name, row.note, row.tone])).toEqual([
      ['db', 'port 5432', 'ok'],
      ['redis', 'Starting', 'busy'],
    ])
    expect(group.canReload && group.canStop).toBe(true)
    expect(group.manage).toBe(true)
    // The local steps stand under their own heading.
    expect(launchpadMenu(v).local.map((row) => [row.name, row.note])).toEqual([['web', 'port 3000']])
  })

  it('before any Run: services from the setup, not started, no pill and no Stop', () => {
    const v = dockerView([])
    v.resolution.steps.push({ ...v.resolution.steps[0], key: `${ROOT}::docker:db`, id: 'docker:db', name: 'db', projectRoot: ROOT, projectName: 'lumen', cwd: ROOT, command: 'x', start: 'now', readyTimeoutMs: 1, from: { command: 'shared', ready: 'shared' }, docker: { projectRoot: ROOT, service: 'db' } })
    const group = dockerMenuGroup(v)!
    expect(group.services.map((row) => row.note)).toEqual(['Not started'])
    expect(group).toMatchObject({ liveHere: false, canReload: false, canStop: false })
  })

  it('the data steps that ran, from the one-time runs main named for them', () => {
    const v = dockerView([dockerStep('db', 'running')], {
      once: [
        onceState('x', { key: `${ROOT}::docker-data:migration-1`, name: 'Update database', status: 'exited', exitCode: 0 }),
        onceState('codegen'),
      ],
    })
    expect(dockerMenuGroup(v)!.data.map((row) => [row.name, row.note])).toEqual([['Update database', 'Done']])
  })

  it('a refused migration says the services started anyway; Docker not running offers Open Docker', () => {
    const v = dockerView([dockerStep('db', 'running')], {
      dockerNotices: [
        { projectRoot: ROOT, kind: 'migration-refused', detail: "This would reach a database that isn't one of this conversation's services, so Flow didn't run it." },
        { projectRoot: ROOT, kind: 'migration-refused', detail: "This would reach a database that isn't one of this conversation's services, so Flow didn't run it." },
        { projectRoot: null, kind: 'docker-unavailable', detail: "Docker isn't running." },
      ],
      offerOpenDocker: true,
    })
    const notices = dockerMenuGroup(v)!.notices
    expect(notices).toHaveLength(2)
    expect(notices[0]!.sentence).toMatch(/The services started anyway\.$/)
    expect(notices[1]).toMatchObject({ title: DOCKER_STRINGS.notRunningTitle, action: 'open-docker' })
  })

  it('what Docker printed goes in the mono block, never in the sentence', () => {
    const face = dockerNoticeFace(
      { projectRoot: ROOT, kind: 'switch-failed', detail: "Docker couldn't create this conversation's services, so they didn't start. Docker said:\npull access denied" },
      false,
      0,
    )
    expect(face.sentence).toBe("Docker couldn't create this conversation's services, so they didn't start.")
    expect(face.lines).toBe('pull access denied')
    expect(splitDetail('One sentence.')).toEqual({ sentence: 'One sentence.', lines: null })
  })

  it('two projects on one port: which two and the port, in the reader’s terms', () => {
    const face = dockerNoticeFace(
      { projectRoot: null, kind: 'port-clash', detail: "api and billing both use port 5432 on this computer, so this conversation's services can't start together. Change the port in one of them and press Run again." },
      false,
      0,
    )
    expect(face).toMatchObject({ title: 'api and billing both use port 5432', sentence: DOCKER_STRINGS.portClash, action: null })
  })

  it('a service that stopped right away: its last lines and Reset data', () => {
    const s = dockerStep('db', 'exited', { exitCode: 1, offerReset: true, detail: 'This service stopped right after starting. Its last lines:\nFATAL: database files are incompatible' })
    const group = dockerMenuGroup(dockerView([s]))!
    expect(group.services[0]!.note).toBe('Stopped right away')
    expect(group.services[0]!.title).not.toContain('FATAL')
    expect(group.notices).toEqual([stoppedRightAwayFace(s)])
    expect(group.notices[0]).toMatchObject({ title: 'db stopped after it started', lines: 'FATAL: database files are incompatible', action: 'reset' })
  })
})
