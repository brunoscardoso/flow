import type { StorylineCompare, StorylineNote, StorylineNotePrediction } from '../../shared/ipc-contract'
import {
  fileLabels,
  mergeReviewNotes,
  noteNumbersLabel,
  noteRows,
  reviewBadgeLabel,
  reviewModes,
  verdictView,
} from './storyline-view-model'
import type { StorylinePiece, StorylineResult } from '../../shared/ipc-contract'
import { buildStory } from './storyline-model'
import { commentRuns, COMMENT_FOLD_MIN_LINES } from './storyline-view-model'
import {
  STORY_DOT_OFFSET,
  STORY_NARROW_SCALE,
  STORY_OPEN_MARGIN_PX,
  STORY_OPEN_SCALE,
  STORY_WIRE_HEADER_Y,
  boxName,
  decorateLines,
  dedentLines,
  fileName,
  findCallSpan,
  followCamera,
  frameCaption,
  isStorylinePath,
  monacoLanguageFor,
  kindBadge,
  openingCamera,
  pieceNamed,
  planLineRuns,
  storyRows,
  storySummary,
  whereLabel,
  wireGeometry,
} from './storyline-view-model'

const FILE = 'app/src/main/project/learn-orchestrator.ts'

function piece(overrides: Partial<StorylinePiece> & Pick<StorylinePiece, 'name'>): StorylinePiece {
  return {
    id: `${FILE}#${overrides.className === undefined ? '' : `${overrides.className}.`}${overrides.name}`,
    kind: 'function',
    file: FILE,
    startLine: 10,
    endLine: 12,
    doc: null,
    text: `${overrides.name}() {}`,
    exported: true,
    ...overrides,
  }
}

const ENQUEUE_TEXT = [
  'enqueueModule(rootPath: string, modulePath: string): void {',
  '    if (this.disposed) return',
  '    this.admit({ rootPath, modulePath })',
  '    recordLearnEvent({ kind: \'queued\' })',
  '    this.trackModuleEnd(job, null)',
  '    this.drain()',
  '  }',
].join('\n')

function fixture(): StorylineResult {
  const enqueue = piece({ name: 'enqueueModule', kind: 'method', className: 'LearnOrchestrator', startLine: 100, endLine: 106, text: ENQUEUE_TEXT, doc: 'Queue a module.' })
  const admit = piece({ name: 'admit', kind: 'method', className: 'LearnOrchestrator', startLine: 200, endLine: 202 })
  const drain = piece({ name: 'drain', kind: 'method', className: 'LearnOrchestrator', startLine: 210, endLine: 212 })
  const track = piece({ name: 'trackModuleEnd', kind: 'method', className: 'LearnOrchestrator', startLine: 220, endLine: 222 })
  const job = piece({ name: 'LearnJob', kind: 'interface', startLine: 5, endLine: 9, text: 'interface LearnJob {}' })
  return {
    ok: true,
    scope: 'file',
    files: [FILE],
    language: 'typescript',
    pieces: [enqueue, admit, drain, track, job],
    calls: [
      { from: enqueue.id, line: 102, to: admit.id },
      { from: enqueue.id, line: 103, to: null, external: { file: 'app/src/main/project/learn-log.ts', name: 'recordLearnEvent' } },
      { from: enqueue.id, line: 104, to: track.id },
      { from: enqueue.id, line: 105, to: drain.id },
      { from: drain.id, line: 211, to: null, unresolvedName: 'loop' },
    ],
    typeUses: [{ from: admit.id, to: job.id }],
    entries: [{ pieceId: enqueue.id, usedFrom: 3 }],
    classes: [{ name: 'LearnOrchestrator', file: FILE, startLine: 80, constructorSignature: 'constructor(deps: Deps)' }],
  }
}

describe('fileLabels', () => {
  it('names a file by its name, adding folders only to tell two of one name apart', () => {
    const labels = fileLabels(['e2e/support/types/chat/chats.ts', 'e2e/support/fixtures/chat/chats.ts', 'src/pages/thread-page.ts', 'src/pages/thread-page.ts'])
    expect([...labels.entries()]).toEqual([
      ['e2e/support/types/chat/chats.ts', 'types/chat/chats.ts'],
      ['e2e/support/fixtures/chat/chats.ts', 'fixtures/chat/chats.ts'],
      ['src/pages/thread-page.ts', 'thread-page.ts'],
    ])
    expect(fileLabels(['a.ts', 'x/a.ts']).get('a.ts')).toBe('a.ts')
  })
})

describe('isStorylinePath / fileName', () => {
  it('reads every language the CLI has a reader for as a story, nothing else', () => {
    for (const path of ['a/b.ts', 'x.tsx', 'y.mts', 'z.cts', 'w.js', 'v.jsx', 'u.mjs', 't.CJS']) expect(isStorylinePath(path)).toBe(true)
    for (const path of ['app/x.py', 'main.go', 'lib.rs', 'A.java', 'B.cs', 'c.rb', 'd.php', 'e.cpp', 'f.h', 'g.sh']) {
      expect(isStorylinePath(path)).toBe(true)
    }
    for (const path of ['a/b.md', 'x.json', '.eslintrc', 'Makefile', 'dir/', 'lib/tool.ex']) expect(isStorylinePath(path)).toBe(false)
  })

  it('colours a box in the story language, or its own file language in a mixed part', () => {
    expect(monacoLanguageFor('typescript', 'a.ts')).toBe('typescript')
    expect(monacoLanguageFor('python', 'a.py')).toBe('python')
    expect(monacoLanguageFor('bash', 'run.sh')).toBe('shell')
    expect(monacoLanguageFor('mixed', 'app/x.py')).toBe('python')
    expect(monacoLanguageFor('mixed', 'web/x.tsx')).toBe('typescript')
    expect(monacoLanguageFor('mixed', 'bin/run.sh')).toBe('shell')
    expect(monacoLanguageFor('mixed', 'notes.txt')).toBe('plaintext')
  })

  it('names a file by its last segment', () => {
    expect(fileName('app/src/main/project/learn-log.ts')).toBe('learn-log.ts')
    expect(fileName('root.ts')).toBe('root.ts')
  })
})

describe('dedentLines', () => {
  it('removes the declaration indent from every line after the first', () => {
    expect(dedentLines(ENQUEUE_TEXT)).toEqual([
      'enqueueModule(rootPath: string, modulePath: string): void {',
      '  if (this.disposed) return',
      '  this.admit({ rootPath, modulePath })',
      "  recordLearnEvent({ kind: 'queued' })",
      '  this.trackModuleEnd(job, null)',
      '  this.drain()',
      '}',
    ])
  })

  it('leaves flush code and one-line pieces alone, and ignores blank lines when measuring', () => {
    expect(dedentLines('function a() {\n  return 1\n}')).toEqual(['function a() {', '  return 1', '}'])
    expect(dedentLines('type A = 1')).toEqual(['type A = 1'])
    expect(dedentLines('f() {\n\n    x()\n  }')).toEqual(['f() {', '', '  x()', '}'])
  })
})

describe('findCallSpan', () => {
  it('finds the called name, preferring a call over a mention', () => {
    const line = 'const admit = this.admit(job)'
    expect(findCallSpan(line, 'admit')).toEqual({ start: 19, end: 24 })
  })

  it('accepts generics and whitespace before the parenthesis', () => {
    expect(findCallSpan('run<Job> (x)', 'run')).toEqual({ start: 0, end: 3 })
  })

  it('matches whole words only, and falls back to a mention', () => {
    expect(findCallSpan('this.drainAll()', 'drain')).toBeNull()
    expect(findCallSpan('void this.loop().finally(() => {})', 'loop')).toEqual({ start: 10, end: 14 })
    expect(findCallSpan('callbacks.push(onDone)', 'onDone')).toEqual({ start: 15, end: 21 })
  })
})

describe('decorateLines', () => {
  it('tints follow lines, names the callee span, chips other files, and marks off-path calls', () => {
    const result = fixture()
    const plan = buildStory(result, result.pieces[0].id)
    const pieces = new Map(result.pieces.map((entry) => [entry.id, entry]))
    const enqueue = result.pieces[0]
    const lines = dedentLines(enqueue.text)
    const marks = plan.marks[enqueue.id] ?? []
    const decor = decorateLines(enqueue, lines, marks, pieces)
    expect(decor).toHaveLength(lines.length)
    expect(decor[2]).toEqual({ callsite: true, follows: [{ to: result.pieces[1].id, span: { start: 7, end: 12 } }], chips: [], notOnPath: false })
    expect(decor[3]?.chips).toEqual([{ file: 'app/src/main/project/learn-log.ts', name: 'recordLearnEvent', label: 'learn-log.ts' }])
    expect(decor[3]?.callsite).toBe(false)
    // trackModuleEnd IS drawn (the walk reaches it), so it is a follow, not off the path.
    expect(decor[4]?.follows.map((follow) => follow.to)).toEqual([result.pieces[3].id])
    expect(decor[5]?.follows[0]?.span).toEqual({ start: 7, end: 12 })
  })

  it('says "not on this path" for a drawn-file piece the story does not reach', () => {
    const enqueue = piece({ name: 'go', startLine: 1, endLine: 2, text: 'go() {\n  other()\n}' })
    const other = piece({ name: 'other', startLine: 9, endLine: 9 })
    const decor = decorateLines(enqueue, dedentLines(enqueue.text), [{ line: 2, kind: 'not-on-path', to: other.id }], new Map([[other.id, other]]))
    expect(decor[1]).toEqual({ callsite: false, follows: [], chips: [], notOnPath: true })
  })

  it('decorates only the shown lines of a folded piece, and leaves unresolved calls plain', () => {
    const long = piece({ name: 'big', startLine: 1, endLine: 4, text: 'big() {\n  a()\n  b()\n}' })
    const a = piece({ name: 'a', startLine: 20, endLine: 20 })
    const decor = decorateLines(
      long,
      dedentLines(long.text),
      [
        { line: 2, kind: 'unresolved', name: 'a' },
        { line: 3, kind: 'follow', to: a.id },
      ],
      new Map([[a.id, a]]),
      2,
    )
    expect(decor).toHaveLength(2)
    expect(decor[1]).toEqual({ callsite: false, follows: [], chips: [], notOnPath: false })
  })

  it('underlines a constructor call by its class name, once per callee per line', () => {
    const ctor = piece({ name: 'constructor', kind: 'method', className: 'Box', isConstructor: true, startLine: 50, endLine: 50 })
    const caller = piece({ name: 'make', startLine: 1, endLine: 1, text: 'make = () => [new Box(1), new Box(2)]' })
    const decor = decorateLines(caller, [caller.text], [{ line: 1, kind: 'follow', to: ctor.id }, { line: 1, kind: 'follow', to: ctor.id }], new Map([[ctor.id, ctor]]))
    expect(decor[0]?.follows).toEqual([{ to: ctor.id, span: { start: 18, end: 21 } }])
  })
})

describe('planLineRuns', () => {
  it('reproduces the line exactly and splits on tokens and the callee span', () => {
    const line = 'this.admit(job)'
    const runs = planLineRuns(
      line,
      [
        { offset: 0, className: 'fl-tok-keyword' },
        { offset: 4, className: 'fl-tok-delimiter' },
        { offset: 5, className: null },
        { offset: 10, className: 'fl-tok-delimiter' },
      ],
      [{ to: 'admit', span: { start: 5, end: 10 } }],
    )
    expect(runs.map((run) => run.text).join('')).toBe(line)
    expect(runs).toEqual([
      { text: 'this', className: 'fl-tok-keyword', follow: null },
      { text: '.', className: 'fl-tok-delimiter', follow: null },
      { text: 'admit', className: null, follow: 0 },
      { text: '(job)', className: 'fl-tok-delimiter', follow: null },
    ])
  })

  it('works with no tokens (before Monaco answers) and with an empty line', () => {
    expect(planLineRuns('a()', null, [{ to: 'a', span: { start: 0, end: 1 } }])).toEqual([
      { text: 'a', className: null, follow: 0 },
      { text: '()', className: null, follow: null },
    ])
    expect(planLineRuns('', null, [])).toEqual([{ text: '', className: null, follow: null }])
  })

  it('ignores a follow with no span and tokens past the line', () => {
    const runs = planLineRuns('x', [{ offset: 9, className: 'fl-tok-number' }], [{ to: 'y', span: null }])
    expect(runs).toEqual([{ text: 'x', className: null, follow: null }])
  })
})

describe('box labels', () => {
  it('badges methods in the class hue and data structures in the type hue', () => {
    expect(kindBadge(piece({ name: 'a', kind: 'method', className: 'C' }))).toEqual({ text: 'method', tone: 'class' })
    expect(kindBadge(piece({ name: 'B', kind: 'interface' }))).toEqual({ text: 'interface', tone: 'type' })
    expect(kindBadge(piece({ name: 'T', kind: 'type' }))).toEqual({ text: 'type', tone: 'type' })
    expect(kindBadge(piece({ name: 'f' }))).toEqual({ text: 'function', tone: 'plain' })
    expect(kindBadge(piece({ name: 'constructor', kind: 'method', className: 'C', isConstructor: true }))).toEqual({ text: 'constructor', tone: 'class' })
  })

  it('names, locates and captions', () => {
    expect(boxName(piece({ name: 'constructor', kind: 'method', className: 'C', isConstructor: true }))).toBe('new C')
    expect(boxName(piece({ name: 'drain' }))).toBe('drain')
    expect(whereLabel(piece({ name: 'a', startLine: 1255, endLine: 1304 }))).toBe('L1255 · 50 lines')
    expect(whereLabel(piece({ name: 'a', startLine: 7, endLine: 7 }))).toBe('L7 · 1 line')
    expect(frameCaption(786, 'constructor(deps: Deps)')).toBe('L786 · constructor(deps: Deps)')
    expect(frameCaption(786, undefined)).toBe('L786')
  })
})

describe('storySummary / storyRows / pieceNamed', () => {
  it('summarises the story and counts calls leaving the file once each', () => {
    const result = fixture()
    const plan = buildStory(result, result.pieces[0].id)
    expect(storySummary(result, plan)).toBe('Starts at enqueueModule · 4 functions · 1 data structure · 1 call leaves this file')
  })

  it('gives each class its own row, then the module functions', () => {
    const result = fixture()
    const withFn: StorylineResult = {
      ...result,
      pieces: [...result.pieces, piece({ name: 'jobKey', startLine: 300, endLine: 302 })],
      calls: [...result.calls, { from: result.pieces[1].id, line: 201, to: `${FILE}#jobKey` }],
    }
    const rows = storyRows(buildStory(withFn, withFn.pieces[0].id))
    expect([...rows.classRow.entries()]).toEqual([[`${FILE}|LearnOrchestrator`, 1]])
    expect(rows.functionRow).toBe(2)
    expect(rows.count).toBe(2)
    const noClass = storyRows(buildStory({ ...withFn, classes: [] }, `${FILE}#jobKey`))
    expect(noClass.functionRow).toBe(1)
    expect(noClass.count).toBe(1)
  })

  it('lands a chip on the piece it called, by name', () => {
    const result = fixture()
    expect(pieceNamed(result, 'drain')).toBe(result.pieces[2].id)
    expect(pieceNamed(result, 'LearnJob')).toBe(result.pieces[4].id)
    expect(pieceNamed(result, 'nope')).toBeNull()
    expect(pieceNamed(result, null)).toBeNull()
  })
})

describe('wireGeometry', () => {
  const from = { x: 100, y: 50, w: 300, h: 200 }

  it('runs a call from the right edge of its call line into the callee header', () => {
    const geometry = wireGeometry('call', from, { x: 100, y: 150, w: 300, h: 18 }, { x: 600, y: 40, w: 280, h: 120 })
    expect(geometry.back).toBe(false)
    expect(geometry.d.startsWith('M400 159 C')).toBe(true)
    expect(geometry.d.endsWith(`598 ${String(40 + STORY_WIRE_HEADER_Y)}`)).toBe(true)
    expect(geometry.dot).toEqual({ x: 600 + STORY_DOT_OFFSET.x, y: 40 + STORY_DOT_OFFSET.y })
  })

  it('loops a back-call into the right edge of a box at or left of its caller', () => {
    const geometry = wireGeometry('call', from, null, { x: 0, y: 400, w: 280, h: 120 })
    expect(geometry.back).toBe(true)
    expect(geometry.d.endsWith(`282 ${String(400 + STORY_WIRE_HEADER_Y)}`)).toBe(true)
  })

  it('leaves a type wire near the top of its box', () => {
    const geometry = wireGeometry('type', from, null, { x: 900, y: 0, w: 200, h: 80 })
    expect(geometry.d.startsWith('M400 76 C')).toBe(true)
  })
})

describe('cameras', () => {
  it('opens readable with the story top-left on screen', () => {
    expect(openingCamera({ x: 66, y: 20 }, { w: 1200, h: 800 })).toEqual({
      k: STORY_OPEN_SCALE,
      x: STORY_OPEN_MARGIN_PX - 66 * STORY_OPEN_SCALE,
      y: STORY_OPEN_MARGIN_PX - 20 * STORY_OPEN_SCALE,
    })
    expect(openingCamera({ x: 0, y: 0 }, { w: 500, h: 800 }).k).toBe(STORY_NARROW_SCALE)
  })

  it('follows a callee: centred when it fits, left-aligned when it is wider than the viewport', () => {
    const fits = followCamera({ k: 1 }, { x: 1000, y: 300, w: 200, h: 100 }, { w: 1000, h: 800 })
    expect(fits.k).toBe(1)
    expect(fits.x).toBe(500 - 1100)
    const wide = followCamera({ k: 0.5 }, { x: 1000, y: 300, w: 2000, h: 100 }, { w: 1000, h: 800 })
    expect(wide.k).toBe(STORY_OPEN_SCALE)
    expect(wide.x).toBe(STORY_OPEN_MARGIN_PX - 1000 * STORY_OPEN_SCALE)
  })
})

describe('commentRuns — long comments fold', () => {
  const never = (): boolean => false
  it('folds a run of three or more comment lines, not shorter ones', () => {
    const lines = ['f() {', '  // one', '  // two', '  x()', '  // a', '  // b', '  // c', '  /* d', '   * e */', '  y()', '}']
    expect(COMMENT_FOLD_MIN_LINES).toBe(3)
    expect(commentRuns(lines, lines.length, never)).toEqual([{ start: 4, end: 8 }])
  })
  it('never folds a line that makes a call, and stops at the lines shown', () => {
    const lines = ['// a', '// b', '// c', '// d', '// e']
    expect(commentRuns(lines, 5, (index) => index === 2)).toEqual([])
    expect(commentRuns(lines, 3, never)).toEqual([{ start: 0, end: 2 }])
  })
})

// ── Plan change review (plan `plan_change_review`) ──────────────────────────


describe('plan change review — notes, modes and words', () => {
  const base = (status: StorylineNote['status'], extra: Partial<StorylineNote> = {}): StorylineNote => ({
    n: 1,
    phase: 1,
    kind: 'change',
    target: 'x',
    file: 'a.ts',
    status,
    comments: [],
    ...extra,
  })

  it('the plan file read wins over the story copy; a note only the story knows is kept', () => {
    const prediction: StorylineNotePrediction = { kind: 'note-file', file: 'a.ts', note: base('proposed') }
    const other: StorylineNotePrediction = { kind: 'note-file', file: 'b.ts', note: { ...base('proposed'), n: 2 } }
    const merged = mergeReviewNotes([prediction, other], [base('accepted')])
    expect(merged.map((view) => [view.note.n, view.note.status, view.prediction?.file])).toEqual([
      [1, 'accepted', 'a.ts'],
      [2, 'proposed', 'b.ts'],
    ])
  })

  it('offers Verify only with a starting point or a verdict', () => {
    const compare = { base: null } as Pick<StorylineCompare, 'base'>
    expect(reviewModes(compare, [base('proposed')])).toEqual(['today', 'proposal'])
    expect(reviewModes({ base: 'abc123' }, [base('proposed')])).toEqual(['today', 'proposal', 'verify'])
    expect(reviewModes(undefined, [base('accepted', { verdict: 'done' })])).toEqual(['today', 'proposal', 'verify'])
  })

  it('writes a change note as Where / What / Why and a new one as Signature / Purpose / Called by / Why', () => {
    expect(noteRows(base('proposed', { where: ': isFull)', what: 'w', why: 'y' })).map((row) => [row.label, row.code])).toEqual([
      ['Where', true],
      ['What', false],
      ['Why', false],
    ])
    expect(noteRows(base('proposed', { kind: 'new', signature: 's()', purpose: 'p', callers: ['a', 'b'], why: 'y' })).map((row) => `${row.label}:${row.text}`)).toEqual([
      'Signature:s()',
      'Purpose:p',
      'Called by:a, b',
      'Why:y',
    ])
    expect(noteRows(base('proposed', { kind: 'file', what: 'w' })).map((row) => row.label)).toEqual(['What'])
    // A file note that quotes its place shows it, like a change note.
    expect(noteRows(base('proposed', { kind: 'file', where: 'export const routes = [', what: 'w' })).map((row) => [row.label, row.code])).toEqual([
      ['Where', true],
      ['What', false],
    ])
  })

  it('reads a verdict with its sentence, else what the diff says', () => {
    expect(verdictView(base('accepted', { verdict: 'done', verdictWhy: 'reads the flag' }), 'changed')).toEqual({ tone: 'ok', text: 'Done as described — reads the flag' })
    expect(verdictView(base('accepted', { verdict: 'differs' }), undefined).tone).toBe('differs')
    expect(verdictView(base('accepted', { verdict: 'not-built' }), undefined).tone).toBe('no')
    expect(verdictView(base('rejected'), undefined).text).toBe('Rejected — execution leaves this note out')
    expect(verdictView(base('accepted'), 'unchanged').text).toBe('Not changed yet')
  })

  it('labels', () => {
    expect(reviewBadgeLabel('change')).toBe('Proposed change')
    expect(reviewBadgeLabel('new')).toBe('New')
    expect(noteNumbersLabel([1])).toBe('note 1')
    expect(noteNumbersLabel([1, 3])).toBe('notes 1, 3')
  })
})
