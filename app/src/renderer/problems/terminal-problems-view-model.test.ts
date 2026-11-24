import { emptyCounts, type ProblemFile } from '../../shared/problems-model'
import type { TerminalProblem, TerminalProblemGroup } from '../../shared/terminal-problems'
import {
  clockTime,
  combinedCounts,
  combinedToggleLabel,
  contextBlock,
  copyAllText,
  countsTooltip,
  DEFAULT_PROBLEMS_FILTER,
  emptyText,
  filterFiles,
  filterTerminalGroups,
  groupHeading,
  problemCopyText,
  problemMetaLine,
  TERMINAL_PROBLEMS_STRINGS,
  terminalFixMessage,
  timesLabel,
} from './terminal-problems-view-model'

const at = (h: number, m: number, s: number): number => new Date(2026, 10, 18, h, m, s).getTime()

function problem(overrides: Partial<TerminalProblem> = {}): TerminalProblem {
  return {
    id: 't1:1',
    terminalId: 't1',
    severity: 'error',
    message: 'ConnectionRefusedError: [Errno 61] Connection refused',
    meta: null,
    count: 14,
    firstSeen: at(20, 55, 14),
    lastSeen: at(20, 56, 6),
    line: 'ConnectionRefusedError: [Errno 61] Connection refused',
    context: [
      '  File ".../asyncpg/connect_utils.py", line 969, in _create_ssl_connection',
      '    tr, pr = await loop.create_connection(',
      '  File "uvloop/loop.pyx", line 2020, in uvloop.loop.Loop.create_connection',
      '    await waiter',
    ],
    firstContext: [],
    ...overrides,
  }
}

function group(overrides: Partial<TerminalProblemGroup> = {}): TerminalProblemGroup {
  return { terminalId: 't1', label: 'core-dev', projectName: 'lumen-core', launchpad: true, problems: [problem()], ...overrides }
}

describe('the row', () => {
  test('meta line: first and last times, the logger and last time, or just the last time', () => {
    expect(clockTime(at(9, 5, 3))).toBe('09:05:03')
    expect(problemMetaLine(problem())).toBe('First 20:55:14 · last 20:56:06')
    expect(problemMetaLine(problem({ meta: 'lumen_core.harness.runtime.stop_signal', count: 31 }))).toBe(
      'lumen_core.harness.runtime.stop_signal · last 20:56:06',
    )
    expect(problemMetaLine(problem({ count: 1, lastSeen: at(20, 55, 52) }))).toBe('last 20:55:52')
    expect(timesLabel(14)).toBe('×14')
  })

  test('the group heading names the project and says Launchpad for a step', () => {
    expect(groupHeading(group())).toEqual({ label: 'core-dev', detail: 'lumen-core · Launchpad' })
    expect(groupHeading(group({ label: 'zsh', launchpad: false }))).toEqual({ label: 'zsh', detail: 'lumen-core' })
  })

  test('the open row shows the lines before, then the problem line', () => {
    expect(contextBlock(problem())).toEqual({ before: problem().context, line: problem().line })
  })
})

describe('Copy', () => {
  test('exactly the agreed format: who and how often, the message, a blank line, the context', () => {
    expect(problemCopyText(group(), problem())).toBe(
      [
        'core-dev (lumen-core) — seen 14 times, 20:55:14 to 20:56:06',
        'ConnectionRefusedError: [Errno 61] Connection refused',
        '',
        '  File ".../asyncpg/connect_utils.py", line 969, in _create_ssl_connection',
        '    tr, pr = await loop.create_connection(',
        '  File "uvloop/loop.pyx", line 2020, in uvloop.loop.Loop.create_connection',
        '    await waiter',
      ].join('\n'),
    )
  })

  test('once, and without context', () => {
    expect(problemCopyText(group(), problem({ count: 1, context: [] }))).toBe(
      'core-dev (lumen-core) — seen once, at 20:56:06\nConnectionRefusedError: [Errno 61] Connection refused',
    )
  })

  test('Copy all joins every shown problem with a blank line', () => {
    const two = group({ problems: [problem({ context: [] }), problem({ id: 't1:2', message: 'RuntimeError: x', context: [] })] })
    expect(copyAllText([two]).split('\n\n')).toHaveLength(2)
  })
})

describe('filters', () => {
  const files: ProblemFile[] = [
    {
      rootId: '/r',
      filePath: 'a.ts',
      counts: { errors: 1, warnings: 1, infos: 0, total: 2 },
      problems: [
        { severity: 'error', message: 'e', line: 1, column: 1 },
        { severity: 'warning', message: 'w', line: 2, column: 1 },
      ],
    },
  ]
  const groups = [group({ problems: [problem(), problem({ id: 't1:2', severity: 'warning' })] })]

  test('All shows both, Terminals and Files one each', () => {
    expect(filterTerminalGroups(groups, DEFAULT_PROBLEMS_FILTER)).toHaveLength(1)
    expect(filterFiles(files, DEFAULT_PROBLEMS_FILTER)).toHaveLength(1)
    expect(filterFiles(files, { ...DEFAULT_PROBLEMS_FILTER, source: 'terminals' })).toEqual([])
    expect(filterTerminalGroups(groups, { ...DEFAULT_PROBLEMS_FILTER, source: 'files' })).toEqual([])
  })

  test('Errors and Warnings toggles keep their severity only; empty groups go', () => {
    const errorsOnly = { ...DEFAULT_PROBLEMS_FILTER, warnings: false }
    expect(filterTerminalGroups(groups, errorsOnly)[0]!.problems.map((p) => p.severity)).toEqual(['error'])
    expect(filterFiles(files, errorsOnly)[0]!.problems.map((p) => p.severity)).toEqual(['error'])
    expect(filterTerminalGroups(groups, { ...DEFAULT_PROBLEMS_FILTER, errors: false, warnings: false })).toEqual([])
  })

  test('the empty state says whether nothing exists or the filters hide it', () => {
    expect(emptyText(DEFAULT_PROBLEMS_FILTER, false, false)).toBe(TERMINAL_PROBLEMS_STRINGS.noProblems)
    expect(emptyText({ ...DEFAULT_PROBLEMS_FILTER, source: 'terminals' }, true, false)).toBe(TERMINAL_PROBLEMS_STRINGS.noTerminalProblems)
    expect(emptyText({ ...DEFAULT_PROBLEMS_FILTER, source: 'files' }, false, true)).toBe(TERMINAL_PROBLEMS_STRINGS.noFileProblems)
    expect(emptyText(DEFAULT_PROBLEMS_FILTER, false, true)).toBe(TERMINAL_PROBLEMS_STRINGS.filteredOut)
  })
})

describe('the counters', () => {
  test('count files and terminals together, and say the split', () => {
    const files = { ...emptyCounts(), errors: 1, total: 1 }
    const terminals = { errors: 2, warnings: 2 }
    expect(combinedCounts(files, terminals)).toEqual({ errors: 3, warnings: 2 })
    expect(countsTooltip(files, terminals)).toBe('3 errors: 1 in files, 2 from terminals. 2 warnings: 2 from terminals.')
    expect(countsTooltip(emptyCounts(), { errors: 0, warnings: 0 })).toBe('No errors. No warnings.')
    expect(combinedToggleLabel(files, terminals)).toBe('Problems: 3 errors, 2 warnings')
  })
})

describe('Fix with agent', () => {
  test('names the terminal, the message and the context, ending with the problem line', () => {
    const text = terminalFixMessage(group(), problem({ meta: 'lumen_core.db' }))
    expect(text).toContain('Fix this error. It was printed by the Launchpad step "core-dev" in lumen-core, seen 14 times, 20:55:14 to 20:56:06.')
    expect(text).toContain('Error: ConnectionRefusedError: [Errno 61] Connection refused')
    expect(text).toContain('From: lumen_core.db')
    expect(text).toContain('        await waiter\n    ConnectionRefusedError: [Errno 61] Connection refused')
    expect(terminalFixMessage(group({ launchpad: false, label: 'zsh' }), problem({ severity: 'warning' }))).toMatch(
      /^Fix this warning\. It was printed by the terminal "zsh"/,
    )
  })
})

// ─── forbidden-pattern #12: no command, path or setting in UI text; no emoji ──

const FORBIDDEN: Array<[string, RegExp]> = [
  ['the CLI', /planflow-ai|plan-flow/i],
  ['a backtick', /`/],
  ['a Flow folder path', /\bflow\/|\/flow\b/],
  ['a file extension', /\.(json|md|ts|ya?ml|flowconfig)\b/],
  ['a flag', /(^|\s)--?[a-z]/],
  ['a config key', /\b[a-z]+_[a-z_]+\b|\b[a-z]+:\s*(true|false)\b/],
  ['an absolute path', /(^|\s)\/[a-z]/i],
  ['an emoji', /\p{Extended_Pictographic}/u],
]

test('fixed UI strings name no command, path, setting or emoji', () => {
  const all = [
    ...Object.values(TERMINAL_PROBLEMS_STRINGS),
    countsTooltip({ ...emptyCounts(), errors: 1 }, { errors: 1, warnings: 3 }),
    combinedToggleLabel(emptyCounts(), { errors: 1, warnings: 1 }),
    groupHeading(group()).detail,
    problemMetaLine(problem()),
  ]
  expect(all.length).toBeGreaterThan(20)
  for (const text of all) {
    for (const [what, pattern] of FORBIDDEN) {
      expect({ text, what, found: pattern.test(text) }).toEqual({ text, what, found: false })
    }
  }
})
