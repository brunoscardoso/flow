// Run-aware learn triggers — pure parse/state core (parseRoundsLine,
// foldRoundsEntry, isModuleInPlayState) and the tail-reading LearnRunTriggers
// consumer (offset tracking, truncation reset, dedupe-on-repeat, enqueue
// wiring). Mirrors flow-observer.test.ts's temp-dir round-trip style.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LearnRunTriggers,
  emptyTriggerRunState,
  foldRoundsEntry,
  isModuleInPlayState,
  parseRoundsLine,
  type FoldResult,
} from './learn-run-triggers'

// ── parseRoundsLine ────────────────────────────────────────────────────────

describe('parseRoundsLine', () => {
  it('parses module_completed entries', () => {
    const line = JSON.stringify({
      ts: '2026-07-15T00:00:00Z',
      run_id: 'feat-x-20260715-000000',
      type: 'module_completed',
      phase: 3,
      module: 'src/auth',
      reason: 'last phase touching module completed',
    })
    expect(parseRoundsLine(line)).toEqual({
      type: 'module_completed',
      run_id: 'feat-x-20260715-000000',
      module: 'src/auth',
    })
  })

  it('parses archive_sweep entries', () => {
    const line = JSON.stringify({
      ts: '2026-07-15T00:05:00Z',
      run_id: 'feat-x-20260715-000000',
      type: 'archive_sweep',
      phase: null,
      modules: ['src/auth', 'src/billing'],
    })
    expect(parseRoundsLine(line)).toEqual({
      type: 'archive_sweep',
      run_id: 'feat-x-20260715-000000',
      modules: ['src/auth', 'src/billing'],
    })
  })

  it('parses phase_result entries down to their module anchors', () => {
    const line = JSON.stringify({
      ts: '2026-07-15T00:01:00Z',
      run_id: 'feat-x-20260715-000000',
      type: 'phase_result',
      phase: 1,
      status: 'success',
      summary: 'Types added',
      anchors: [
        { kind: 'module', ref: 'src/auth' },
        { kind: 'file', ref: 'src/auth/token.ts' },
      ],
    })
    expect(parseRoundsLine(line)).toEqual({
      type: 'phase_result',
      run_id: 'feat-x-20260715-000000',
      moduleAnchors: ['src/auth'],
    })
  })

  it('returns null for entry types it does not act on', () => {
    const kinds = ['verification', 'risk', 'escalation', 'run_intent', 'plan_decision', 'review_verdict']
    for (const type of kinds) {
      const line = JSON.stringify({ run_id: 'r1', type })
      expect(parseRoundsLine(line)).toBeNull()
    }
  })

  it('returns null for malformed JSON, non-objects, and missing run_id', () => {
    expect(parseRoundsLine('not json')).toBeNull()
    expect(parseRoundsLine('42')).toBeNull()
    expect(parseRoundsLine('[]')).toBeNull()
    expect(parseRoundsLine(JSON.stringify({ type: 'module_completed', module: 'src/x' }))).toBeNull()
  })
})

// ── foldRoundsEntry / isModuleInPlayState ──────────────────────────────────

describe('foldRoundsEntry', () => {
  it('phase_result adds module anchors to the run in-play set with no actions', () => {
    const { state, actions }: FoldResult = foldRoundsEntry(emptyTriggerRunState(), {
      type: 'phase_result',
      run_id: 'run-1',
      moduleAnchors: ['src/auth', 'src/billing'],
    })
    expect(actions).toEqual([])
    expect(isModuleInPlayState(state, 'src/auth')).toBe(true)
    expect(isModuleInPlayState(state, 'src/billing')).toBe(true)
    expect(isModuleInPlayState(state, 'src/other')).toBe(false)
  })

  it('module_completed releases the module and emits an auto enqueue action', () => {
    const afterTouch = foldRoundsEntry(emptyTriggerRunState(), {
      type: 'phase_result',
      run_id: 'run-1',
      moduleAnchors: ['src/auth'],
    }).state
    const { state, actions } = foldRoundsEntry(afterTouch, {
      type: 'module_completed',
      run_id: 'run-1',
      module: 'src/auth',
    })
    expect(actions).toEqual([{ module: 'src/auth', reason: 'run module completed', deliberate: false }])
    expect(isModuleInPlayState(state, 'src/auth')).toBe(false)
  })

  it('archive_sweep clears the whole run and emits a deliberate action per module', () => {
    const afterTouch = foldRoundsEntry(emptyTriggerRunState(), {
      type: 'phase_result',
      run_id: 'run-1',
      moduleAnchors: ['src/auth', 'src/billing'],
    }).state
    const { state, actions } = foldRoundsEntry(afterTouch, {
      type: 'archive_sweep',
      run_id: 'run-1',
      modules: ['src/auth', 'src/billing'],
    })
    expect(actions).toEqual([
      { module: 'src/auth', reason: 'post-run sweep', deliberate: true },
      { module: 'src/billing', reason: 'post-run sweep', deliberate: true },
    ])
    expect(isModuleInPlayState(state, 'src/auth')).toBe(false)
    expect(isModuleInPlayState(state, 'src/billing')).toBe(false)
  })

  it('tracks separate runs independently', () => {
    let state = emptyTriggerRunState()
    state = foldRoundsEntry(state, { type: 'phase_result', run_id: 'run-1', moduleAnchors: ['src/a'] }).state
    state = foldRoundsEntry(state, { type: 'phase_result', run_id: 'run-2', moduleAnchors: ['src/b'] }).state
    expect(isModuleInPlayState(state, 'src/a')).toBe(true)
    expect(isModuleInPlayState(state, 'src/b')).toBe(true)
    state = foldRoundsEntry(state, { type: 'archive_sweep', run_id: 'run-1', modules: ['src/a'] }).state
    expect(isModuleInPlayState(state, 'src/a')).toBe(false)
    expect(isModuleInPlayState(state, 'src/b')).toBe(true)
  })
})

// ── LearnRunTriggers (tail-reading consumer) ───────────────────────────────

function appendLine(path: string, entry: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: 'a' })
}

describe('LearnRunTriggers.checkRoot', () => {
  let root: string
  let roundsPath: string
  let enqueueModule: jest.Mock

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learn-run-triggers-'))
    const flowDir = join(root, 'flow')
    mkdirSync(flowDir, { recursive: true })
    roundsPath = join(flowDir, '.rounds.jsonl')
    enqueueModule = jest.fn()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is a no-op when the rounds file does not exist yet', async () => {
    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)
    expect(enqueueModule).not.toHaveBeenCalled()
  })

  it('parses interleaved rounds lines, ignoring irrelevant types, and enqueues releases', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'phase_result', phase: 1, anchors: [{ kind: 'module', ref: 'src/auth' }] })
    appendLine(roundsPath, { ts: 't2', run_id: 'run-1', type: 'verification', phase: 1, task: 1, status: 'pass' })
    appendLine(roundsPath, { ts: 't3', run_id: 'run-1', type: 'escalation', phase: 1, what: 'x', choice: 'y' })
    appendLine(roundsPath, { ts: 't4', run_id: 'run-1', type: 'module_completed', phase: 2, module: 'src/auth', reason: 'last phase touching module completed' })
    appendLine(roundsPath, { ts: 't5', run_id: 'run-1', type: 'risk', phase: null, risk_level: 'low', risk_rationale: 'fine' })

    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)

    expect(enqueueModule).toHaveBeenCalledTimes(1)
    expect(enqueueModule).toHaveBeenCalledWith(root, 'src/auth', {
      reason: 'run module completed',
      deliberate: false,
    })
    expect(triggers.isModuleInPlay(root, 'src/auth')).toBe(false)
  })

  it('archive_sweep enqueues every touched module as deliberate', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'phase_result', phase: 1, anchors: [{ kind: 'module', ref: 'src/auth' }, { kind: 'module', ref: 'src/billing' }] })
    appendLine(roundsPath, { ts: 't2', run_id: 'run-1', type: 'archive_sweep', phase: null, modules: ['src/auth', 'src/billing'] })

    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)

    expect(enqueueModule).toHaveBeenCalledTimes(2)
    expect(enqueueModule).toHaveBeenNthCalledWith(1, root, 'src/auth', { reason: 'post-run sweep', deliberate: true })
    expect(enqueueModule).toHaveBeenNthCalledWith(2, root, 'src/billing', { reason: 'post-run sweep', deliberate: true })
    expect(triggers.isModuleInPlay(root, 'src/auth')).toBe(false)
    expect(triggers.isModuleInPlay(root, 'src/billing')).toBe(false)
  })

  it('a module is in play between its phase_result anchor and its release', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'phase_result', phase: 1, anchors: [{ kind: 'module', ref: 'src/auth' }] })

    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)
    expect(triggers.isModuleInPlay(root, 'src/auth')).toBe(true)

    appendLine(roundsPath, { ts: 't2', run_id: 'run-1', type: 'module_completed', phase: 2, module: 'src/auth', reason: 'last phase touching module completed' })
    await triggers.checkRoot(root)
    expect(triggers.isModuleInPlay(root, 'src/auth')).toBe(false)
  })

  it('dedupes repeated reads — a second checkRoot with no new bytes enqueues nothing', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'module_completed', phase: 1, module: 'src/auth', reason: 'last phase touching module completed' })

    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)
    expect(enqueueModule).toHaveBeenCalledTimes(1)

    await triggers.checkRoot(root)
    await triggers.checkRoot(root)
    expect(enqueueModule).toHaveBeenCalledTimes(1)
  })

  it('resets the offset and in-play state when the file shrinks (truncation/rotation)', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'phase_result', phase: 1, anchors: [{ kind: 'module', ref: 'src/auth' }] })

    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)
    expect(triggers.isModuleInPlay(root, 'src/auth')).toBe(true)

    // Simulate archive + fresh run: the file is truncated to empty — the
    // stored byte cursor is now beyond the (smaller) file size. This must
    // not throw, must reset the cursor to 0, and must drop the stale
    // in-play bookkeeping from the truncated run rather than carry it
    // forward forever.
    writeFileSync(roundsPath, '')
    await triggers.checkRoot(root)
    expect(triggers.isModuleInPlay(root, 'src/auth')).toBe(false)

    // A fresh run's entry, appended after the reset, is read from the start
    // (offset 0) and processed normally.
    appendLine(roundsPath, { ts: 't2', run_id: 'run-2', type: 'module_completed', phase: 1, module: 'src/billing', reason: 'last phase touching module completed' })
    await triggers.checkRoot(root)
    expect(enqueueModule).toHaveBeenCalledWith(root, 'src/billing', {
      reason: 'run module completed',
      deliberate: false,
    })
  })

  it('skips a torn trailing line and picks it up complete on the next read', async () => {
    const complete = JSON.stringify({ ts: 't1', run_id: 'run-1', type: 'module_completed', phase: 1, module: 'src/auth', reason: 'last phase touching module completed' })
    writeFileSync(roundsPath, `${complete}\n`)
    // Append a partial (unterminated) line simulating a mid-write read.
    appendFileSync(roundsPath, '{"ts":"t2","run_id":"run-1","type":"module_comp')

    const triggers = new LearnRunTriggers({ enqueueModule })
    await triggers.checkRoot(root)
    expect(enqueueModule).toHaveBeenCalledTimes(1)

    // Complete the line and re-check — it should now parse (module_completed
    // for a different module) without re-processing the first line.
    appendFileSync(
      roundsPath,
      `leted","phase":2,"module":"src/billing","reason":"last phase touching module completed"}\n`,
    )
    await triggers.checkRoot(root)
    expect(enqueueModule).toHaveBeenCalledTimes(2)
    expect(enqueueModule).toHaveBeenNthCalledWith(2, root, 'src/billing', {
      reason: 'run module completed',
      deliberate: false,
    })
  })

  it('attach() re-tails a root on a state-changed event named after it', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'module_completed', phase: 1, module: 'src/auth', reason: 'last phase touching module completed' })

    const triggers = new LearnRunTriggers({ enqueueModule })
    let listener: ((payload: { rootId: string }) => void) | null = null
    triggers.attach({
      on: (_event, cb) => {
        listener = cb
        return undefined
      },
    })
    expect(listener).not.toBeNull()
    listener!({ rootId: root })
    // attach's callback is fire-and-forget (async checkRoot) — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve))
    expect(enqueueModule).toHaveBeenCalledWith(root, 'src/auth', {
      reason: 'run module completed',
      deliberate: false,
    })
  })

  it('is fail-soft when enqueueModule throws — other actions still run', async () => {
    appendLine(roundsPath, { ts: 't1', run_id: 'run-1', type: 'archive_sweep', phase: null, modules: ['src/auth', 'src/billing'] })
    const throwing = jest.fn((_root: string, module: string) => {
      if (module === 'src/auth') {
        throw new Error('boom')
      }
    })
    const triggers = new LearnRunTriggers({ enqueueModule: throwing, onError: jest.fn() })
    await expect(triggers.checkRoot(root)).resolves.toBeUndefined()
    expect(throwing).toHaveBeenCalledTimes(2)
  })
})
