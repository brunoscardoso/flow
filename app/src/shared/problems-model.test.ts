import type { Diagnostic, DiagnosticSeverity, DiagnosticsEvent } from './ipc-contract'
import {
  countSummary,
  fileLabel,
  fixDisabledReason,
  fixMessage,
  MAX_PROBLEMS_PER_MESSAGE,
  NO_PROBLEMS_TEXT,
  pathForAgent,
  problemsSnapshot,
  problemsTabLabel,
  refsOf,
  sourceLabel,
} from './problems-model'

const ROOT = '/work/app'

function diag(severity: DiagnosticSeverity, line: number, character = 0, message = `${severity} at ${line}`, extra: Partial<Diagnostic> = {}): Diagnostic {
  return {
    severity,
    message,
    range: { start: { line, character }, end: { line, character: character + 1 } },
    ...extra,
  }
}

function file(filePath: string, diagnostics: Diagnostic[], rootId = ROOT): DiagnosticsEvent {
  return { rootId, filePath, diagnostics }
}

describe('problemsSnapshot — grouping, counting, ordering', () => {
  it('groups by file with full per-file and total counts, one-based positions', () => {
    const snapshot = problemsSnapshot([
      file('src/a.ts', [diag('warning', 4, 2), diag('error', 9, 0, 'bad', { source: 'ts', code: '2322' })]),
      file('src/b.ts', [diag('info', 0)]),
    ])
    expect(snapshot.counts).toEqual({ errors: 1, warnings: 1, infos: 1, total: 3 })
    expect(snapshot.withheld).toBe(0)
    expect(snapshot.files.map((f) => f.filePath)).toEqual(['src/a.ts', 'src/b.ts'])
    const [a] = snapshot.files
    expect(a!.counts).toEqual({ errors: 1, warnings: 1, infos: 0, total: 2 })
    expect(a!.problems[0]).toEqual({ severity: 'error', message: 'bad', source: 'ts', code: '2322', line: 10, column: 1 })
    expect(a!.problems[1]).toMatchObject({ severity: 'warning', line: 5, column: 3 })
  })

  it('leaves hints out entirely, and a file with only hints is not listed', () => {
    const snapshot = problemsSnapshot([
      file('src/hints.ts', [diag('hint', 1), diag('hint', 2)]),
      file('src/real.ts', [diag('hint', 1), diag('error', 3)]),
    ])
    expect(snapshot.files.map((f) => f.filePath)).toEqual(['src/real.ts'])
    expect(snapshot.counts.total).toBe(1)
  })

  it('orders files worst-first, then by path; problems by severity then position', () => {
    const snapshot = problemsSnapshot([
      file('a-warn.ts', [diag('warning', 1)]),
      file('z-err.ts', [diag('warning', 1), diag('error', 7, 4), diag('error', 7, 1), diag('error', 2)]),
      file('b-err.ts', [diag('error', 1)]),
      file('c-info.ts', [diag('info', 1)]),
    ])
    expect(snapshot.files.map((f) => f.filePath)).toEqual(['b-err.ts', 'z-err.ts', 'a-warn.ts', 'c-info.ts'])
    const z = snapshot.files[1]!
    expect(z.problems.map((p) => `${p.severity}@${p.line}:${p.column}`)).toEqual([
      'error@3:1',
      'error@8:2',
      'error@8:5',
      'warning@2:1',
    ])
  })

  it('is empty for no events, and for events that cleared their file', () => {
    expect(problemsSnapshot([])).toEqual({ files: [], counts: { errors: 0, warnings: 0, infos: 0, total: 0 }, withheld: 0 })
    expect(problemsSnapshot([file('src/a.ts', [])]).files).toEqual([])
  })
})

describe('problemsSnapshot — the bound', () => {
  it('fills the bound by severity across files: warnings in one file never push out errors in another', () => {
    const noisy = Array.from({ length: 50 }, (_, i) => diag('warning', i))
    const snapshot = problemsSnapshot(
      [file('a-noisy.ts', [diag('error', 0), ...noisy]), file('b.ts', [diag('error', 0)])],
      3,
    )
    // Positive first: the bound sent exactly three, and both errors are in it.
    expect(snapshot.files.flatMap((f) => f.problems)).toHaveLength(3)
    expect(snapshot.files.map((f) => f.problems.filter((p) => p.severity === 'error').length)).toEqual([1, 1])
    expect(snapshot.withheld).toBe(49)
    // Counts stay whole, so the view can say what it was not sent.
    expect(snapshot.files[0]!.counts.total).toBe(51)
    expect(snapshot.counts.total).toBe(52)
  })

  it('limit 0 is a counts-only read', () => {
    const snapshot = problemsSnapshot([file('a.ts', [diag('error', 0), diag('warning', 1)])], 0)
    expect(snapshot.counts).toEqual({ errors: 1, warnings: 1, infos: 0, total: 2 })
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]!.problems).toEqual([])
    expect(snapshot.withheld).toBe(2)
  })
})

describe('labels', () => {
  it('the tab carries the count, and nothing when there are none', () => {
    expect(problemsTabLabel({ errors: 2, warnings: 1, infos: 0, total: 3 })).toBe('Problems 3')
    expect(problemsTabLabel({ errors: 0, warnings: 0, infos: 0, total: 0 })).toBe('Problems')
  })

  it('splits a path into name and folder', () => {
    expect(fileLabel('src/editor/index.ts')).toEqual({ name: 'index.ts', folder: 'src/editor' })
    expect(fileLabel('README.md')).toEqual({ name: 'README.md', folder: '' })
  })

  it('names source and code together, or whichever exists', () => {
    expect(sourceLabel({ source: 'ts', code: '2322' })).toBe('ts 2322')
    expect(sourceLabel({ source: 'eslint' })).toBe('eslint')
    expect(sourceLabel({})).toBe('')
  })

  it('summarises counts in words, with plurals', () => {
    expect(countSummary({ errors: 1, warnings: 2, infos: 0, total: 3 })).toBe('1 error, 2 warnings')
    expect(countSummary({ errors: 0, warnings: 0, infos: 1, total: 1 })).toBe('1 info message')
  })

  it('the empty state speaks in user terms — no server, no command, no config key', () => {
    expect(NO_PROBLEMS_TEXT).toMatch(/open/)
    expect(NO_PROBLEMS_TEXT).not.toMatch(/language server|lsp|planflow|`/i)
  })

  it('Fix with agent is disabled with a plain reason when no conversation is open', () => {
    expect(fixDisabledReason('t1')).toBeNull()
    expect(fixDisabledReason(null)).toMatch(/conversation/)
  })
})

describe('fixMessage — the one message a press sends', () => {
  const snapshot = problemsSnapshot([
    file('src/a.ts', [
      diag('error', 1, 6, "Type 'string' is not assignable\n  to type 'number'.", { source: 'ts', code: '2322' }),
    ]),
    file('src/b.ts', [diag('warning', 4, 0, 'Unused thing')]),
  ])

  it('names each problem by path:line:column, severity, message and source', () => {
    const text = fixMessage(refsOf(snapshot.files), ROOT)!
    expect(text).toContain('Fix these 2 problems.')
    expect(text).toContain("- src/a.ts:2:7 — error: Type 'string' is not assignable to type 'number'. (ts 2322)")
    expect(text).toContain('- src/b.ts:5:1 — warning: Unused thing')
    expect(text).not.toContain('more')
  })

  it('a single problem reads in the singular', () => {
    const text = fixMessage(refsOf([snapshot.files[1]!]), ROOT)!
    expect(text.startsWith('Fix this problem.')).toBe(true)
  })

  it('uses an absolute path when the file is outside the conversation’s project', () => {
    const text = fixMessage(refsOf(snapshot.files), '/work/other')!
    expect(text).toContain('- /work/app/src/a.ts:2:7')
    expect(pathForAgent('/work/app/', 'x.ts', '/work/app')).toBe('x.ts')
    expect(pathForAgent('/work/app', 'x.ts', null)).toBe('/work/app/x.ts')
  })

  it('caps the list and names what it left out, including problems never sent', () => {
    const many = problemsSnapshot([file('a.ts', Array.from({ length: 60 }, (_, i) => diag('error', i)))])
    const text = fixMessage(refsOf(many.files), ROOT, 5)!
    const listed = text.split('\n').filter((line) => line.startsWith('- a.ts:'))
    expect(listed).toHaveLength(MAX_PROBLEMS_PER_MESSAGE)
    expect(text).toContain('Fix these 65 problems.')
    expect(text).toContain('- 25 more problems are not listed here.')
  })

  it('sends nothing for nothing', () => {
    expect(fixMessage([], ROOT)).toBeNull()
  })
})
