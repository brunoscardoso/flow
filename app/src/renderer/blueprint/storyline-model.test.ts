import { isNotePrediction, notePredictionsOf } from './storyline-model'
import type { StorylineCall, StorylineCompare, StorylinePiece, StorylineResult } from '../../shared/ipc-contract'
import {
  DEFAULT_PREVIEW_LINES,
  STORY_CAPTION_MAX_CHARS,
  STORY_ROW,
  applyCompare,
  buildStory,
  clampCaption,
  compareStory,
  compareSummary,
  diffDisplayLines,
  todayDisplayLines,
  defaultEntry,
  entryOptions,
  pieceLabel,
} from './storyline-model'

const FILE = 'app/src/main/learn/orchestrator.ts'
const CLASS = 'LearnOrchestrator'

function method(name: string, startLine: number, lines: number): StorylinePiece {
  return {
    id: `${FILE}#${CLASS}.${name}`,
    kind: 'method',
    name,
    className: CLASS,
    file: FILE,
    startLine,
    endLine: startLine + lines - 1,
    doc: `${name} doc.`,
    text: `${name}() {}`,
    exported: true,
  }
}

function fn(name: string, startLine: number, lines: number, file = FILE): StorylinePiece {
  return {
    id: `${file}#${name}`,
    kind: 'function',
    name,
    file,
    startLine,
    endLine: startLine + lines - 1,
    doc: null,
    text: `function ${name}() {}`,
    exported: true,
  }
}

function data(name: string, kind: 'interface' | 'type', startLine: number, lines: number): StorylinePiece {
  return { ...fn(name, startLine, lines), kind, text: `${kind} ${name} {}` }
}

const M = (name: string): string => `${FILE}#${CLASS}.${name}`
const F = (name: string): string => `${FILE}#${name}`

const call = (from: string, line: number, to: string | null, extra: Partial<StorylineCall> = {}): StorylineCall => ({
  from,
  line,
  to,
  ...extra,
})

function learnOrchestrator(): StorylineResult {
  return {
    ok: true,
    scope: 'file',
    files: [FILE],
    language: 'typescript',
    pieces: [
      method('noteMovement', 1208, 3),
      method('enqueueModule', 1255, 50),
      method('setRootPaused', 1511, 11),
      method('admit', 1664, 17),
      method('drain', 1682, 10),
      method('loop', 1707, 44),
      method('onBudgetDrop', 1797, 3),
      method('runJob', 1831, 177),
      method('transition', 2008, 28),
      data('LearnJob', 'interface', 73, 10),
      fn('jobKey', 86, 3),
      data('LearnQueueState', 'interface', 91, 10),
      data('EnqueueResult', 'interface', 109, 4),
      fn('enqueueJob', 115, 12),
      data('TakeNextResult', 'type', 129, 4),
      fn('takeNext', 140, 28),
      fn('completeActive', 169, 8),
    ],
    calls: [
      call(M('enqueueModule'), 1290, M('admit')),
      call(M('enqueueModule'), 1300, M('drain')),
      call(M('setRootPaused'), 1515, M('noteMovement')),
      call(M('setRootPaused'), 1518, M('drain')),
      call(M('admit'), 1666, null, { external: { file: 'app/src/main/learn/learn-log.ts', name: 'recordLearnEvent' } }),
      call(M('admit'), 1670, F('enqueueJob')),
      call(M('admit'), 1676, M('transition')),
      call(M('drain'), 1688, M('loop')),
      call(M('loop'), 1710, F('takeNext')),
      call(M('loop'), 1716, M('onBudgetDrop')),
      call(M('loop'), 1720, M('noteMovement')),
      call(M('loop'), 1730, M('runJob')),
      call(M('loop'), 1740, F('completeActive')),
      call(M('loop'), 1745, null, { unresolvedName: 'this.trackModuleEnd' }),
      call(M('onBudgetDrop'), 1798, M('transition')),
      call(M('runJob'), 1900, M('transition')),
      call(M('runJob'), 1950, null, { external: { file: 'app/src/main/learn/learn-log.ts', name: 'recordLearnEvent' } }),
      call(F('enqueueJob'), 116, F('jobKey')),
      call(F('takeNext'), 150, F('jobKey')),
      call(F('completeActive'), 172, F('jobKey')),
    ],
    typeUses: [
      { from: M('admit'), to: F('LearnJob') },
      { from: M('runJob'), to: F('LearnJob') },
      { from: M('onBudgetDrop'), to: F('LearnJob') },
      { from: F('enqueueJob'), to: F('LearnQueueState') },
      { from: F('enqueueJob'), to: F('LearnJob') },
      { from: F('enqueueJob'), to: F('EnqueueResult') },
      { from: F('takeNext'), to: F('LearnQueueState') },
      { from: F('takeNext'), to: F('TakeNextResult') },
      { from: F('completeActive'), to: F('LearnQueueState') },
      { from: F('LearnQueueState'), to: F('LearnJob') },
      { from: F('TakeNextResult'), to: F('LearnJob') },
      { from: F('TakeNextResult'), to: F('LearnQueueState') },
      { from: F('EnqueueResult'), to: F('LearnQueueState') },
    ],
    entries: [
      { pieceId: M('enqueueModule'), usedFrom: 4 },
      { pieceId: M('setRootPaused'), usedFrom: 2 },
    ],
    classes: [{ name: CLASS, file: FILE, startLine: 1150, constructorSignature: 'constructor(deps: LearnDeps)' }],
  }
}

describe('storyline-model — the learn-orchestrator story', () => {
  const result = learnOrchestrator()
  const plan = buildStory(result, M('enqueueModule'))

  it('visits depth-first, calls by line, each piece once', () => {
    expect(plan.order).toEqual([
      M('enqueueModule'), M('admit'), F('enqueueJob'), F('jobKey'), M('transition'), M('drain'),
      M('loop'), F('takeNext'), M('onBudgetDrop'), M('noteMovement'), M('runJob'), F('completeActive'),
    ])
    expect(plan.stepOf[M('enqueueModule')]).toBe(0)
    expect(plan.stepOf[F('completeActive')]).toBe(11)
  })

  it('draws the data structures the drawn pieces use', () => {
    expect(plan.drawn.slice(plan.order.length)).toEqual([
      F('LearnJob'), F('LearnQueueState'), F('EnqueueResult'), F('TakeNextResult'),
    ])
    expect(plan.typeEdges).toContainEqual({ from: F('TakeNextResult'), to: F('LearnQueueState') })
  })

  it('places columns by call depth, data structures last', () => {
    expect(plan.columns[M('enqueueModule')]).toBe(0)
    expect(plan.columns[M('admit')]).toBe(1)
    expect(plan.columns[M('drain')]).toBe(1)
    expect(plan.columns[M('loop')]).toBe(2)
    expect(plan.columns[M('runJob')]).toBe(3)
    expect(plan.columns[M('transition')]).toBe(4)
    expect(plan.columns[F('jobKey')]).toBe(4)
    expect(plan.dataColumn).toBe(5)
    expect(plan.columns[F('LearnJob')]).toBe(5)
  })

  it('frames the class across its members, functions below, data last', () => {
    expect(plan.frames).toEqual([
      {
        className: CLASS, file: FILE, startLine: 1150, constructorSignature: 'constructor(deps: LearnDeps)',
        colStart: 0, colEnd: plan.columns[M('transition')],
      },
    ])
    const cellAt = (col: number, row: number) => plan.cells.find((cell) => cell.col === col && cell.row === row)
    expect(cellAt(1, STORY_ROW.member)?.pieceIds).toEqual([M('admit'), M('drain')])
    expect(cellAt(3, STORY_ROW.member)?.pieceIds).toEqual([M('onBudgetDrop'), M('noteMovement'), M('runJob')])
    expect(cellAt(2, STORY_ROW.function)?.pieceIds).toEqual([F('enqueueJob')])
    expect(cellAt(3, STORY_ROW.function)?.pieceIds).toEqual([F('takeNext'), F('completeActive')])
    expect(cellAt(5, STORY_ROW.data)?.pieceIds).toHaveLength(4)
    expect(plan.cells.every((cell) => cell.file === undefined)).toBe(true)
  })

  it('draws every call between drawn pieces, back-calls included', () => {
    const toTransition = plan.edges.filter((edge) => edge.to === M('transition'))
    expect(toTransition.map((edge) => edge.from)).toEqual([M('admit'), M('onBudgetDrop'), M('runJob')])
    expect(toTransition.every((edge) => edge.step === plan.stepOf[M('transition')])).toBe(true)
    expect(plan.edges).toHaveLength(15)
  })

  it('marks each call line', () => {
    expect(plan.marks[M('admit')]).toEqual([
      { line: 1666, kind: 'chip', file: 'app/src/main/learn/learn-log.ts', name: 'recordLearnEvent' },
      { line: 1670, kind: 'follow', to: F('enqueueJob') },
      { line: 1676, kind: 'follow', to: M('transition') },
    ])
    expect(plan.marks[M('enqueueModule')]?.map((mark) => mark.kind)).toEqual(['follow', 'follow'])
    expect(plan.marks[M('loop')]).toContainEqual({ line: 1745, kind: 'unresolved', name: 'this.trackModuleEnd' })
    expect(plan.marks[M('drain')]).toEqual([{ line: 1688, kind: 'follow', to: M('loop') }])
  })

  it('folds a long piece to a preview', () => {
    expect(plan.long).toEqual({ [M('runJob')]: { previewLines: DEFAULT_PREVIEW_LINES, totalLines: 177 } })
    expect(buildStory(result, M('enqueueModule'), { longPieceLines: 40 }).long[M('loop')]).toEqual({
      previewLines: DEFAULT_PREVIEW_LINES,
      totalLines: 44,
    })
  })

  it('tells another entry its own story', () => {
    const paused = buildStory(result, M('setRootPaused'))
    expect(paused.order[0]).toBe(M('setRootPaused'))
    for (const absent of [M('enqueueModule'), M('admit'), F('enqueueJob'), F('EnqueueResult')]) {
      expect(paused.drawn).not.toContain(absent)
    }
    expect(paused.drawn).toEqual(expect.arrayContaining([M('loop'), M('runJob'), F('TakeNextResult'), F('LearnJob')]))
  })

  it('groups a single file', () => {
    expect(Object.keys(plan.fileGroups)).toEqual([FILE])
    expect(plan.fileGroups[FILE]).toHaveLength(plan.drawn.length)
  })

  it('returns an empty plan for an unknown entry', () => {
    const empty = buildStory(result, 'nowhere#x')
    expect(empty.order).toEqual([])
    expect(empty.cells).toEqual([])
  })
})

describe('storyline-model — edges of the graph', () => {
  it('terminates on recursion and cycles, reusing the box', () => {
    const a = fn('a', 1, 5)
    const b = fn('b', 10, 5)
    const result: StorylineResult = {
      ok: true, scope: 'file', files: [FILE], language: 'typescript',
      pieces: [a, b],
      calls: [call(a.id, 2, a.id), call(a.id, 3, b.id), call(b.id, 11, a.id)],
      typeUses: [], entries: [], classes: [],
    }
    const plan = buildStory(result, a.id)
    expect(plan.order).toEqual([a.id, b.id])
    expect(plan.columns).toEqual({ [a.id]: 0, [b.id]: 1 })
    expect(plan.edges).toHaveLength(3)
    expect(plan.marks[a.id]?.[0]).toEqual({ line: 2, kind: 'follow', to: a.id })
  })

  it('gives no frame to a class with no drawn member', () => {
    const result = learnOrchestrator()
    const solo = buildStory(result, F('jobKey'))
    expect(solo.order).toEqual([F('jobKey')])
    expect(solo.frames).toEqual([])
  })

  it('marks a call to a non-callable piece as off the path', () => {
    const result = learnOrchestrator()
    const withTypeCall: StorylineResult = { ...result, calls: [...result.calls, call(F('jobKey'), 87, F('LearnJob'))] }
    expect(buildStory(withTypeCall, F('jobKey')).marks[F('jobKey')]).toEqual([
      { line: 87, kind: 'not-on-path', to: F('LearnJob') },
    ])
  })

  it('groups pieces by file and splits cells per file in part mode', () => {
    const other = 'app/src/main/learn/queue.ts'
    const entry = fn('start', 1, 5)
    const helper = fn('helper', 3, 4, other)
    const sibling = fn('sibling', 10, 4)
    const result: StorylineResult = {
      ok: true, scope: 'part', files: [FILE, other], language: 'typescript',
      pieces: [entry, helper, sibling],
      calls: [call(entry.id, 2, helper.id), call(entry.id, 4, sibling.id)],
      typeUses: [], entries: [], classes: [],
    }
    const plan = buildStory(result, entry.id)
    expect(plan.fileGroups).toEqual({ [FILE]: [entry.id, sibling.id], [other]: [helper.id] })
    const col1 = plan.cells.filter((cell) => cell.col === 1)
    expect(col1).toEqual([
      { col: 1, row: STORY_ROW.function, file: other, pieceIds: [helper.id] },
      { col: 1, row: STORY_ROW.function, file: FILE, pieceIds: [sibling.id] },
    ])
  })
})

describe('storyline-model — entries and labels', () => {
  it('opens at the top-ranked entry', () => {
    expect(defaultEntry(learnOrchestrator())).toBe(M('enqueueModule'))
  })

  it('falls back to the first callable piece in file order', () => {
    expect(defaultEntry({ ...learnOrchestrator(), entries: [] })).toBe(F('jobKey'))
    expect(defaultEntry({ ...learnOrchestrator(), entries: [], pieces: [data('X', 'type', 1, 1)] })).toBeNull()
  })

  it('lists entries in rank order with labels', () => {
    expect(entryOptions(learnOrchestrator())).toEqual([
      { pieceId: M('enqueueModule'), label: 'LearnOrchestrator.enqueueModule()', doc: 'enqueueModule doc.', usedFrom: 4 },
      { pieceId: M('setRootPaused'), label: 'LearnOrchestrator.setRootPaused()', doc: 'setRootPaused doc.', usedFrom: 2 },
    ])
  })

  it('labels each kind', () => {
    expect(pieceLabel(fn('jobKey', 1, 1))).toBe('jobKey()')
    expect(pieceLabel(data('LearnJob', 'interface', 1, 1))).toBe('interface LearnJob')
    expect(pieceLabel({ ...method('constructor', 1, 1), isConstructor: true })).toBe('new LearnOrchestrator()')
  })
})

// ── Today ⇄ After ────────────────────────────────────────────────────────

const SHOP = 'src/shop/cart.ts'
const S = (name: string): string => `${SHOP}#${name}`

function shopFn(name: string, startLine: number, text: string): StorylinePiece {
  const lines = text.split('\n').length
  return { id: S(name), kind: 'function', name, file: SHOP, startLine, endLine: startLine + lines - 1, doc: null, text, exported: true }
}

/** After: checkout → total → (new) discount; Today also had `legacyTax`. */
function shopResult(compare?: StorylineCompare): StorylineResult {
  return {
    ok: true,
    scope: 'file',
    files: [SHOP],
    language: 'typescript',
    pieces: [
      shopFn('checkout', 1, 'function checkout() {\n  return total()\n}'),
      shopFn('total', 5, 'function total() {\n  const sum = 1\n  return discount(sum)\n}'),
      shopFn('discount', 10, 'function discount(n) {\n  return n\n}'),
      shopFn('untouched', 14, 'function untouched() {}'),
    ],
    calls: [
      { from: S('checkout'), line: 2, to: S('total') },
      { from: S('total'), line: 7, to: S('discount') },
      { from: S('checkout'), line: 2, to: S('untouched') },
    ],
    typeUses: [],
    entries: [{ pieceId: S('checkout'), usedFrom: 1 }],
    classes: [],
    ...(compare === undefined ? {} : { compare }),
  }
}

/** `total` changed: `return sum` became `return discount(sum)`. */
const TOTAL_HUNKS = [
  {
    todayStart: 6,
    afterStart: 6,
    lines: [
      { op: 'context' as const, text: '  const sum = 1' },
      { op: 'removed' as const, text: '  return sum' },
      { op: 'added' as const, text: '  return discount(sum)' },
      { op: 'context' as const, text: '}' },
    ],
  },
]

function realCompare(): StorylineCompare {
  return {
    plan: 'shop-discounts',
    base: 'abc123',
    baseSource: 'run',
    pieces: { [S('checkout')]: 'same', [S('total')]: 'changed', [S('discount')]: 'added', [S('untouched')]: 'same', [S('legacyTax')]: 'removed' },
    removed: [shopFn('legacyTax', 12, 'function legacyTax() {\n  return 0\n}')],
    hunks: { [S('total')]: TOTAL_HUNKS },
    hiddenLines: {},
    unreadable: [],
    predicted: [
      { pieceId: S('untouched'), file: SHOP, symbol: 'untouched', phase: 2, task: 'Tidy untouched()', kind: 'changes' },
      { file: SHOP, symbol: 'refund', phase: 3, task: 'Add refund() for returned carts', kind: 'planned' },
      { file: 'src/shop/coupons.ts', phase: 3, task: 'Coupons live in their own file', kind: 'planned-file' },
    ],
    summary: { changed: 1, added: 1, removed: 1, predicted: 1, planned: 2 },
  }
}

function predictionOnly(): StorylineCompare {
  return {
    ...realCompare(),
    base: null,
    baseSource: null,
    pieces: {},
    removed: [],
    hunks: {},
    predicted: [
      { pieceId: S('total'), file: SHOP, symbol: 'total', phase: 1, task: 'x'.repeat(200), kind: 'changes' },
      { file: SHOP, symbol: 'refund', phase: 3, task: 'Add refund() for returned carts', kind: 'planned' },
    ],
    summary: { changed: 0, added: 0, removed: 0, predicted: 1, planned: 1 },
  }
}

describe('storyline-model — Today ⇄ After', () => {
  it('weaves a changed piece: After lines in order, removed lines where they were', () => {
    const piece = shopResult().pieces[1] as StorylinePiece
    const woven = diffDisplayLines(piece, TOTAL_HUNKS)
    expect(woven.map((line) => [line.op, line.text, line.afterIndex])).toEqual([
      ['plain', 'function total() {', 0],
      ['plain', '  const sum = 1', 1],
      ['removed', '  return sum', null],
      ['added', '  return discount(sum)', 2],
      ['plain', '}', 3],
    ])
  })

  it("rebuilds Today's text of a changed piece exactly from After and its diff", () => {
    const piece = shopResult().pieces[1] as StorylinePiece
    const today = todayDisplayLines(diffDisplayLines(piece, TOTAL_HUNKS))
    expect(today.map((line) => line.text).join('\n')).toBe('function total() {\n  const sum = 1\n  return sum\n}')
    expect(today.every((line) => line.op === 'plain')).toBe(true)
    // Unchanged lines keep their After line, so calls and wires still land.
    expect(today.map((line) => line.afterIndex)).toEqual([0, 1, null, 3])
  })

  it('After: added, changed (with its diff), removed, predicted — each its own state and pill', () => {
    const result = shopResult(realCompare())
    const plan = buildStory(result, S('checkout'))
    const view = compareStory(result, plan, result.compare as StorylineCompare, 'after')
    expect(view.looks[S('discount')]).toMatchObject({ state: 'added', pill: 'Added' })
    expect(view.looks[S('total')]).toMatchObject({ state: 'changed', pill: 'Changed' })
    expect(view.looks[S('total')]?.lines?.some((line) => line.op === 'removed')).toBe(true)
    expect(view.looks[S('legacyTax')]).toMatchObject({ state: 'removed', pill: 'Removed' })
    expect(view.looks[S('untouched')]).toMatchObject({ state: 'predicted', pill: 'Changes in phase 2', caption: 'Tidy untouched()' })
    expect(view.looks[S('checkout')]).toMatchObject({ state: 'same', pill: null })
    expect(view.ghosts.map((ghost) => [ghost.kind, ghost.name, ghost.pill])).toEqual([
      ['planned', 'refund()', 'Planned in phase 3'],
      ['planned-file', 'coupons.ts', 'Planned in phase 3'],
    ])
    expect(view.hidden).toEqual([])
    expect(view.rail).toEqual({ [S('total')]: 'changed', [S('discount')]: 'added', [S('untouched')]: 'predicted' })
    expect(view.summary).toBe('Plan shop-discounts: 1 changed · 1 added · 1 removed · 1 still to change · 2 planned')
  })

  it("Today: no marks, Today's text, added pieces gone, removed pieces plain, no ghosts", () => {
    const result = shopResult(realCompare())
    const plan = buildStory(result, S('checkout'))
    const view = compareStory(result, plan, result.compare as StorylineCompare, 'today')
    for (const look of Object.values(view.looks)) {
      expect(look.state).toBe('same')
      expect(look.pill).toBeNull()
      expect(look.caption).toBeNull()
    }
    expect(view.looks[S('total')]?.lines?.map((line) => line.text)).toContain('  return sum')
    expect(view.looks[S('total')]?.lines?.some((line) => line.op !== 'plain')).toBe(false)
    expect(view.hidden).toEqual([S('discount')])
    expect(view.ghosts).toEqual([])
    expect(view.rail).toEqual({})
    expect(view.extras.map((piece) => piece.id)).toEqual([S('legacyTax')])
  })

  it('never hides the entry, even when it is new', () => {
    const compare = { ...realCompare(), pieces: { ...realCompare().pieces, [S('checkout')]: 'added' as const } }
    const result = shopResult(compare)
    const view = compareStory(result, buildStory(result, S('checkout')), compare, 'today')
    expect(view.hidden).not.toContain(S('checkout'))
  })

  it('places removed pieces and ghosts in the last call column, and drops hidden pieces and their wires', () => {
    const result = shopResult(realCompare())
    const plan = buildStory(result, S('checkout'))
    const after = applyCompare(plan, compareStory(result, plan, result.compare as StorylineCompare, 'after'))
    const last = Math.max(...plan.order.map((id) => plan.columns[id] ?? 0))
    const cell = after.cells.find((entry) => entry.col === last && entry.row === STORY_ROW.function)
    expect(cell?.pieceIds).toEqual(expect.arrayContaining([S('legacyTax'), `planned:${SHOP}#refund`, 'planned-file:src/shop/coupons.ts']))
    expect(after.edges.some((edge) => edge.from === S('legacyTax'))).toBe(false)

    const today = applyCompare(plan, compareStory(result, plan, result.compare as StorylineCompare, 'today'))
    expect(today.drawn).not.toContain(S('discount'))
    expect(today.order).not.toContain(S('discount'))
    expect(today.edges.some((edge) => edge.to === S('discount'))).toBe(false)
    expect(today.cells.flatMap((entry) => entry.pieceIds)).toContain(S('legacyTax'))
  })

  it('with no starting point: the prediction only, said in the foot, the caption clamped', () => {
    const result = shopResult(predictionOnly())
    const plan = buildStory(result, S('checkout'))
    const view = compareStory(result, plan, result.compare as StorylineCompare, 'after')
    expect(view.summary).toBe('No starting point yet — showing what the plan says will change')
    const look = view.looks[S('total')]
    expect(look).toMatchObject({ state: 'predicted', pill: 'Changes in phase 1' })
    expect(look?.caption?.length).toBe(STORY_CAPTION_MAX_CHARS)
    expect(look?.caption?.endsWith('…')).toBe(true)
    expect(look?.captionTitle).toBe('x'.repeat(200))
    expect(view.ghosts).toHaveLength(1)
  })

  it('a prediction is never drawn as fact, and a fact never as a prediction', () => {
    const result = shopResult(realCompare())
    const view = compareStory(result, buildStory(result, S('checkout')), result.compare as StorylineCompare, 'after')
    const factStates = new Set(['added', 'changed', 'removed'])
    expect(factStates.has(view.looks[S('untouched')]?.state ?? '')).toBe(false)
    expect(view.looks[S('total')]?.state).toBe('changed')
  })

  it('says nothing changed yet when the base matches the working tree', () => {
    const compare = { ...realCompare(), summary: { changed: 0, added: 0, removed: 0, predicted: 0, planned: 0 } }
    expect(compareSummary(compare)).toBe('Plan shop-discounts: nothing changed yet')
  })

  it('clamps a caption to the limit with an ellipsis, and keeps a short one whole', () => {
    expect(clampCaption('Short task')).toBe('Short task')
    const long = clampCaption('word '.repeat(40))
    expect(long.length).toBeLessThanOrEqual(STORY_CAPTION_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('outside a plan the story is unchanged — no compare, nothing to apply', () => {
    const result = shopResult()
    expect(result.compare).toBeUndefined()
    const plan = buildStory(result, S('checkout'))
    expect(buildStory(shopResult(), S('checkout'))).toEqual(plan)
  })
})

// ── Plan change review (plan `plan_change_review`) ──────────────────────────


describe('change-note predictions', () => {
  it('tells note predictions from phase predictions', () => {
    const compare = {
      plan: 'p',
      base: null,
      baseSource: null,
      pieces: {},
      removed: [],
      hunks: {},
      hiddenLines: {},
      unreadable: [],
      summary: { changed: 0, added: 0, removed: 0, predicted: 1, planned: 1 },
      predicted: [
        { kind: 'changes', file: FILE, phase: 1, task: 't' },
        { kind: 'note-file', file: FILE, note: { n: 1, phase: 1, kind: 'file', target: 'x', file: FILE, status: 'proposed', comments: [] } },
      ],
    } as StorylineCompare
    expect(compare.predicted.map(isNotePrediction)).toEqual([false, true])
    expect(notePredictionsOf(compare).map((prediction) => prediction.kind)).toEqual(['note-file'])
    expect(notePredictionsOf(undefined)).toEqual([])
  })
})

