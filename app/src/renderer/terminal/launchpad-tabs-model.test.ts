import type { RunGroupState, RunStepState, RunStepStatus } from '../../shared/run-setup'
import {
  DEFAULT_GROUP_VIEW,
  GroupViewMemory,
  groupMenu,
  groupTabFace,
  groupTabId,
  isGroupTabId,
  LAUNCHPAD_TAB_STRINGS,
  paneFace,
  parseGrouped,
  planStrip,
  selectedStep,
  separateStepMenu,
  serializeGrouped,
  spansProjects,
  stepIsGoing,
  stepKeyOfTerminal,
  stepStateText,
  stepTone,
  subBar,
} from './launchpad-tabs-model'

const APP = '/work/jupiter-app'
const CORE = '/work/jupiter-core'
const SCOPE = `${APP}::t1`

function step(name: string, status: RunStepStatus, extra: Partial<RunStepState> = {}): RunStepState {
  return {
    key: `${extra.projectRoot ?? APP}::${name}`,
    name,
    projectRoot: APP,
    status,
    terminalId: status === 'idle' ? null : `term-${name}`,
    exitCode: null,
    detail: null,
    ...extra,
  }
}

function state(steps: RunStepState[], once: RunGroupState['once'] = []): RunGroupState {
  return { scopeKey: SCOPE, active: steps.some(stepIsGoing), steps, once }
}

interface Tab {
  id: string
}
const tab = (id: string): Tab => ({ id })
const idOf = (item: Tab): string => item.id
const names = (root: string): string => root.split('/').pop() ?? root

const FOUR = [
  step('app-dev', 'ready'),
  step('core-dev', 'running', { projectRoot: CORE }),
  step('temporal-dev', 'running', { projectRoot: CORE }),
  step('temporal-worker', 'exited', { projectRoot: CORE, exitCode: 1 }),
]

describe('the strip', () => {
  const visible = [tab('shell-1'), tab('term-app-dev'), tab('term-core-dev'), tab('term-temporal-dev'), tab('term-temporal-worker'), tab('shell-2')]

  it('grouped: one Launchpad tab stands for every step, first; the shells keep their tabs', () => {
    const entries = planStrip(visible, idOf, state(FOUR), true)
    expect(entries.map((entry) => entry.kind)).toEqual(['group', 'plain', 'plain'])
    const group = entries[0]
    expect(group).toMatchObject({ kind: 'group', id: groupTabId(SCOPE), scopeKey: SCOPE })
    expect(group.kind === 'group' ? group.steps.map((s) => s.name) : []).toEqual([
      'app-dev',
      'core-dev',
      'temporal-dev',
      'temporal-worker',
    ])
    expect(entries.slice(1).map((entry) => (entry.kind === 'plain' ? entry.item.id : null))).toEqual(['shell-1', 'shell-2'])
  })

  it('separate: exactly today’s order — one tab per step, no group', () => {
    const entries = planStrip(visible, idOf, state(FOUR), false)
    expect(entries.map((entry) => entry.kind)).toEqual(['step', 'step', 'step', 'step', 'plain', 'plain'])
    expect(entries.some((entry) => entry.kind === 'group')).toBe(false)
  })

  it('a step with no terminal yet joins the group; a one-time action keeps its own tab', () => {
    const steps = [step('db', 'running'), step('api', 'idle')]
    const once = [{ key: `${APP}::lint`, name: 'lint', projectRoot: APP, projectName: 'jupiter-app', status: 'running' as const, terminalId: 'term-lint', exitCode: null, durationMs: null }]
    const entries = planStrip([tab('term-db'), tab('term-lint'), tab('shell')], idOf, state(steps, once), true)
    expect(entries.map((entry) => entry.kind)).toEqual(['group', 'once', 'plain'])
    expect(entries[0].kind === 'group' ? entries[0].steps.map((s) => s.name) : []).toEqual(['db', 'api'])
  })

  it('no Run here: no group tab, every tab as it was', () => {
    const entries = planStrip([tab('shell')], idOf, null, true)
    expect(entries).toEqual([{ kind: 'plain', item: tab('shell') }])
    expect(planStrip([tab('shell')], idOf, state([]), true).map((e) => e.kind)).toEqual(['plain'])
  })

  it('group tab ids are recognised, and nothing else is', () => {
    expect(isGroupTabId(groupTabId(SCOPE))).toBe(true)
    expect(isGroupTabId('term-1')).toBe(false)
    expect(isGroupTabId('run-step:x')).toBe(false)
    expect(isGroupTabId(null)).toBe(false)
  })
})

describe('the group tab’s face', () => {
  it('says what is running, with one dot per step in step order and no count', () => {
    const face = groupTabFace(FOUR)
    expect(face.label).toBe('3 of 4 running')
    expect(face).not.toHaveProperty('count')
    expect(face.tones).toEqual(['ok', 'ok', 'ok', 'bad'])
    expect(face.tooltip).toBe('Launchpad: 3 running, 1 not running as expected')
  })

  it('labels: all running, some running, starting, stopped', () => {
    expect(groupTabFace([step('a', 'running'), step('b', 'ready')]).label).toBe('2 running')
    expect(groupTabFace([step('a', 'running'), step('b', 'idle')]).label).toBe('1 of 2 running')
    expect(groupTabFace([step('a', 'starting'), step('b', 'idle')]).label).toBe('Starting')
    expect(groupTabFace([step('a', 'idle'), step('b', 'stopped')]).label).toBe('Stopped')
    expect(groupTabFace([step('a', 'exited', { exitCode: 1 })]).label).toBe('Stopped')
  })

  it('dots: ok running/ready, busy starting/waiting, bad failed, off stopped/idle/finished', () => {
    const tones = (
      [
        ['running', null],
        ['ready', null],
        ['starting', null],
        ['waiting', null],
        ['exited', 1],
        ['timed-out', null],
        ['blocked', null],
        ['stopped', null],
        ['idle', null],
        ['exited', 0],
      ] as Array<[RunStepStatus, number | null]>
    ).map(([status, exitCode]) => stepTone(step('x', status, { exitCode })))
    expect(tones).toEqual(['ok', 'ok', 'busy', 'busy', 'bad', 'bad', 'bad', 'off', 'off', 'off'])
  })
})

describe('a step’s state in words', () => {
  it('reads as the menu shows it', () => {
    expect(stepStateText(step('a', 'ready'))).toBe('ready')
    expect(stepStateText(step('a', 'running'))).toBe('running')
    expect(stepStateText(step('a', 'exited', { exitCode: 1 }))).toBe('exited 1')
    expect(stepStateText(step('a', 'exited', { exitCode: 0 }))).toBe('finished')
    expect(stepStateText(step('a', 'exited'))).toBe('exited')
    expect(stepStateText(step('a', 'blocked'))).toBe('port busy')
    expect(stepStateText(step('a', 'blocked', { notHere: true }))).toBe("can't start")
    expect(stepStateText(step('a', 'timed-out'))).toBe('not ready')
    expect(stepStateText(step('a', 'stopped'))).toBe('stopped')
    expect(stepStateText(step('a', 'idle'))).toBe('not started')
  })
})

describe('the sub-bar', () => {
  it('All first, then each step with its dot; project names when the group spans projects', () => {
    expect(spansProjects(FOUR)).toBe(true)
    const bar = subBar(FOUR, DEFAULT_GROUP_VIEW, names)
    expect(bar.items.map((item) => [item.key === 'all' ? 'all' : item.label, item.tone, item.project, item.pressed])).toEqual([
      ['all', null, null, true],
      ['app-dev', 'ok', 'jupiter-app', false],
      ['core-dev', 'ok', 'jupiter-core', false],
      ['temporal-dev', 'ok', 'jupiter-core', false],
      ['temporal-worker', 'bad', 'jupiter-core', false],
    ])
    expect(bar.showLayout).toBe(true)
    expect(bar.layout).toBe('tiles')
  })

  it('one project: no project names; a step selected hides the layout switch', () => {
    const steps = [step('db', 'running'), step('web', 'running')]
    expect(spansProjects(steps)).toBe(false)
    const bar = subBar(steps, { selection: { step: `${APP}::web` }, layout: 'log' }, names)
    expect(bar.items.map((item) => item.pressed)).toEqual([false, false, true])
    expect(bar.items.every((item) => item.project === null)).toBe(true)
    expect(bar.showLayout).toBe(false)
  })
})

describe('a pane’s header', () => {
  it('a running step: Restart, Stop live, its project and state', () => {
    const face = paneFace(FOUR[1], names)
    expect(face).toMatchObject({
      name: 'core-dev',
      project: 'jupiter-core',
      state: 'running',
      primary: 'Restart',
      canStop: true,
      hasTerminal: true,
    })
  })

  it('an exited step: Start, Stop disabled, and it keeps its terminal (its last output)', () => {
    const face = paneFace(FOUR[3], names)
    expect(face).toMatchObject({ primary: 'Start', canStop: false, state: 'exited 1', hasTerminal: true })
    expect(face.stopTitle).toBe(LAUNCHPAD_TAB_STRINGS.stopIdleTitle)
  })

  it('a step never started has no terminal and offers Start', () => {
    expect(paneFace(step('api', 'idle'), names)).toMatchObject({ primary: 'Start', hasTerminal: false, canStop: false })
  })
})

describe('the caret menus', () => {
  it('group: All steps, each step with its dot and state, then Show as separate tabs', () => {
    const menu = groupMenu(FOUR.slice(0, 2).concat(FOUR[3]))
    expect(menu).toEqual([
      { kind: 'all', label: 'All steps' },
      { kind: 'separator' },
      { kind: 'step', key: `${APP}::app-dev`, label: 'app-dev', tone: 'ok', state: 'ready' },
      { kind: 'step', key: `${CORE}::core-dev`, label: 'core-dev', tone: 'ok', state: 'running' },
      { kind: 'step', key: `${CORE}::temporal-worker`, label: 'temporal-worker', tone: 'bad', state: 'exited 1' },
      { kind: 'separator' },
      { kind: 'separate', label: 'Show as separate tabs' },
    ])
  })

  it('a step tab in separate mode offers the way back', () => {
    expect(separateStepMenu()).toEqual([{ kind: 'group', label: 'Group Launchpad tabs' }])
  })
})

describe('the preference', () => {
  it('grouped by default; separate only when a person chose it', () => {
    expect(parseGrouped(null)).toBe(true)
    expect(parseGrouped('true')).toBe(true)
    expect(parseGrouped('garbage')).toBe(true)
    expect(parseGrouped('false')).toBe(false)
    expect(parseGrouped(serializeGrouped(false))).toBe(false)
    expect(parseGrouped(serializeGrouped(true))).toBe(true)
  })
})

describe('which view each group was left on', () => {
  it('defaults to All, Side by side', () => {
    const memory = new GroupViewMemory()
    expect(memory.get(SCOPE, FOUR)).toEqual({ selection: 'all', layout: 'tiles' })
    expect(selectedStep(memory.get(SCOPE, FOUR))).toBeNull()
  })

  it('remembers the selection and layout per group, independently', () => {
    const memory = new GroupViewMemory()
    memory.setLayout(SCOPE, 'log')
    memory.select(SCOPE, { step: FOUR[1].key })
    expect(memory.get(SCOPE, FOUR)).toEqual({ selection: { step: FOUR[1].key }, layout: 'log' })
    expect(selectedStep(memory.get(SCOPE, FOUR))).toBe(FOUR[1].key)
    // Another group has its own.
    expect(memory.get('other::', FOUR)).toEqual(DEFAULT_GROUP_VIEW)
    memory.select(SCOPE, 'all')
    expect(memory.get(SCOPE, FOUR)).toEqual({ selection: 'all', layout: 'log' })
  })

  it('a selected step that left the group falls back to All, keeping the layout', () => {
    const memory = new GroupViewMemory()
    memory.setLayout(SCOPE, 'log')
    memory.select(SCOPE, { step: FOUR[3].key })
    expect(selectedStep(memory.get(SCOPE, FOUR))).toBe(FOUR[3].key)
    expect(memory.get(SCOPE, FOUR.slice(0, 3))).toEqual({ selection: 'all', layout: 'log' })
  })
})

describe('which step a terminal belongs to', () => {
  const run = { scopeKey: SCOPE, stepId: 'core-dev', projectRoot: CORE }

  it('the group’s own answer first', () => {
    expect(stepKeyOfTerminal(state(FOUR), 'term-core-dev', run)).toBe(`${CORE}::core-dev`)
  })

  it('before the state names the terminal, its run tag — but only for a step of this group', () => {
    const steps = [step('core-dev', 'starting', { projectRoot: CORE, terminalId: null })]
    expect(stepKeyOfTerminal(state(steps), 'term-new', run)).toBe(`${CORE}::core-dev`)
    expect(stepKeyOfTerminal(state(steps), 'term-new', { ...run, stepId: 'lint' })).toBeNull()
    expect(stepKeyOfTerminal(state(steps), 'term-new', { ...run, scopeKey: 'elsewhere' })).toBeNull()
  })

  it('a plain shell belongs to no step', () => {
    expect(stepKeyOfTerminal(state(FOUR), 'shell-1', undefined)).toBeNull()
  })
})

// ─── forbidden-pattern #12 ───────────────────────────────────────────────────

const FORBIDDEN: Array<[string, RegExp]> = [
  ['the CLI', /planflow-ai|plan-flow/i],
  ['a backtick', /`/],
  ['a file extension', /\.(json|md|ts|ya?ml|flowconfig)\b/],
  ['a flag', /(^|\s)--?[a-z]/],
  ['a config key', /\b[a-z]+_[a-z_]+\b|\b[a-z]+:\s*(true|false)\b/],
  ['an absolute path', /(^|\s)\/[a-z]/i],
]

describe('UI text (forbidden-pattern #12)', () => {
  it('names no command line, path or setting, and uses no emoji', () => {
    const all: string[] = [...Object.values(LAUNCHPAD_TAB_STRINGS), groupTabFace(FOUR).tooltip]
    for (const s of FOUR.concat(step('idle', 'idle'), step('b', 'blocked', { notHere: true }))) {
      const face = paneFace(s, names)
      all.push(face.state, face.primary, face.primaryTitle, face.stopTitle)
    }
    for (const entry of groupMenu(FOUR)) if ('label' in entry) all.push(entry.label)
    const offenders: string[] = []
    for (const text of all) {
      for (const [what, pattern] of FORBIDDEN) if (pattern.test(text)) offenders.push(`${what}: ${text}`)
      if (/\p{Extended_Pictographic}/u.test(text)) offenders.push(`an emoji: ${text}`)
    }
    expect(all.length).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
