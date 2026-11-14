import type { RunGroupState, RunStepState, RunStepStatus, RunSuggestion, RunView } from '../../shared/run-setup'
import {
  applyRunUpdate,
  askAgentPrompt,
  groupHasRun,
  orderRunTabs,
  pendingTabAction,
  pendingTabId,
  pendingTabTooltip,
  pickerRows,
  pickerText,
  pillFace,
  RUN_MARK_TITLE,
  RUN_STRINGS,
  runningThreads,
  stepKeyOfPendingTab,
  stepOfTerminal,
  stepTabFace,
  threadIdOfScopeKey,
} from './run-group-model'
import { LAYER_LABELS, LAYER_TITLES, SETUP_STRINGS } from './run-setup-model'

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
      projects: [],
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

describe('pillFace', () => {
  it('hides without a view and offers Set up Run for a scope with no steps', () => {
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

describe('the first-time picker', () => {
  const found: RunSuggestion[] = [
    { projectRoot: ROOT, projectName: 'jupiter-core', name: 'temporal', command: 'temporal server start-dev', source: 'README' },
    { projectRoot: ROOT, projectName: 'jupiter-core', name: 'temporal', command: 'temporal server start-dev', source: 'Procfile' },
    { projectRoot: '/work/app', projectName: 'jupiter-app', name: 'dev', command: 'npm run dev', source: 'package.json' },
  ]

  it('lists each command once with its project and source', () => {
    expect(pickerRows(found).map((r) => [r.command, r.meta])).toEqual([
      ['temporal server start-dev', 'jupiter-core · README'],
      ['npm run dev', 'jupiter-app · package.json'],
    ])
  })

  it('names the projects it looked at', () => {
    expect(pickerText('jupiter', ['jupiter-core', 'jupiter-app'], 2)).toEqual({
      title: 'Start jupiter with one button',
      body: 'Flow looked at jupiter-core and jupiter-app and found these. Tick what you run, then put them in order.',
    })
    expect(pickerText('jupiter', [], 0).body).toContain('found nothing to start in jupiter')
  })

  it('asks the agent to propose, not to start anything', () => {
    const prompt = askAgentPrompt('jupiter', found.slice(2))
    expect(prompt).toContain('Do not start anything')
    expect(prompt).toContain('- npm run dev (jupiter-app, package.json)')
  })
})

describe('the sidebar running mark', () => {
  it('reads conversations from summaries and scope keys', () => {
    expect(threadIdOfScopeKey(`${ROOT}::thread-1`)).toBe('thread-1')
    expect(threadIdOfScopeKey(`${ROOT}::`)).toBeNull()
    expect(
      [...runningThreads([
        { scopeKey: 'a::t1', rootPath: 'a', threadId: 't1', running: 2 },
        { scopeKey: 'a::', rootPath: 'a', threadId: null, running: 1 },
        { scopeKey: 'a::t2', rootPath: 'a', threadId: 't2', running: 0 },
      ])],
    ).toEqual(['t1'])
  })

  it('reports a change only when a conversation starts or stops having a Run', () => {
    const first = applyRunUpdate(new Set(), group([step('a', 'running')], true))
    expect(first.changed).toBe(true)
    expect(applyRunUpdate(first.running, group([step('a', 'ready')], true)).changed).toBe(false)
    expect(applyRunUpdate(first.running, group([step('a', 'stopped')], false))).toEqual({ running: new Set(), changed: true })
    expect(applyRunUpdate(new Set(), { scopeKey: `${ROOT}::`, active: true, steps: [] }).changed).toBe(false)
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
    ...Object.values(LAYER_LABELS),
    ...Object.values(LAYER_TITLES),
    RUN_MARK_TITLE,
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
  all.push(...Object.values(pickerText('jupiter', ['jupiter-core'], 1)), ...Object.values(pickerText('jupiter', [], 0)))
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
