import { describe, expect, it, jest } from '@jest/globals'

import type { CliRunResult } from '../agent/learn-session'
import {
  PLAN_NOTES_TIMEOUT_MS,
  PLAN_NOTE_WRITE_TIMEOUT_MS,
  countPlanNotes,
  narrowPlanNoteReport,
  parsePlanNotesStdout,
  readPlanNotes,
  serializePlanNoteWrites,
  setPlanNote,
  type PlanNotesDeps,
} from './plan-notes-runner'

const CLI = { execPath: '/electron', cliPath: '/bundle/planflow-ai.mjs' }
const ROOT = '/repo'

const CHANGE_NOTE = {
  n: 1,
  phase: 2,
  kind: 'change',
  target: 'file:src/a.ts:run',
  file: 'src/a.ts',
  symbol: 'run',
  where: 'return value',
  what: 'Return the count.',
  why: 'Callers need it.',
  status: 'accepted',
  comments: ['looks right'],
  quote: { found: 'once', startLine: 4, endLine: 4 },
}

const NEW_NOTE = {
  n: 2,
  phase: 2,
  kind: 'new',
  target: 'api/file:src/b.ts:make',
  project: 'api',
  file: 'src/b.ts',
  symbol: 'make',
  signature: 'make(x: number): string',
  purpose: 'Builds the label.',
  callers: ['run'],
  status: 'proposed',
  comments: [],
}

const NOTES_ANSWER = {
  plan: 'demo',
  path: 'flow/plans/plan_demo_v1.md',
  notes: [CHANGE_NOTE, NEW_NOTE],
  counts: { total: 2, accepted: 1, rejected: 0, unreviewed: 1 },
  unreadable: [{ line: 40, reason: 'no target', n: 3 }],
}

interface Call {
  cwd: string
  args: readonly string[]
  options: { timeoutMs?: number; env?: Record<string, string> } | undefined
}

function fakeRun(answer: CliRunResult): { run: NonNullable<PlanNotesDeps['run']>; calls: Call[] } {
  const calls: Call[] = []
  const run = jest.fn(async (_cli: unknown, cwd: string, args: readonly string[], options?: Call['options']) => {
    calls.push({ cwd, args, options })
    return answer
  }) as unknown as NonNullable<PlanNotesDeps['run']>
  return { run, calls }
}

describe('readPlanNotes', () => {
  it('runs `plan notes --json` in the root with the reader paths, and relays the narrowed answer', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: `noise\n${JSON.stringify(NOTES_ANSWER)}\n` })
    const answer = await readPlanNotes(
      { bundledCli: CLI, run, typescriptPath: '/ts.js', treeSitterPath: '/tsw' },
      { rootPath: ROOT, plan: 'demo' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(ROOT)
    expect(calls[0].args).toEqual(['plan', 'notes', 'demo', '--target', ROOT, '--json'])
    expect(calls[0].options).toEqual({
      timeoutMs: PLAN_NOTES_TIMEOUT_MS,
      env: { FLOW_TYPESCRIPT_PATH: '/ts.js', FLOW_TREESITTER_PATH: '/tsw' },
    })
    expect(answer).toEqual({ ok: true, ...NOTES_ANSWER })
  })

  it('drops a malformed note and recounts from the notes that survived', async () => {
    const broken = { ...CHANGE_NOTE, n: 4, status: 'maybe' }
    const noKind = { ...NEW_NOTE, n: 5, kind: undefined }
    const stdout = JSON.stringify({ ...NOTES_ANSWER, notes: [CHANGE_NOTE, broken, noKind, 'x', NEW_NOTE], counts: { total: 5, accepted: 2, rejected: 0, unreviewed: 3 } })
    const { run } = fakeRun({ ok: true, stdout })
    const answer = await readPlanNotes({ bundledCli: CLI, run }, { rootPath: ROOT, plan: 'demo' })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.notes.map((note) => note.n)).toEqual([1, 2])
    expect(answer.counts).toEqual({ total: 2, accepted: 1, rejected: 0, unreviewed: 1 })
  })

  it('surfaces a refusal sentence without the command hint, and keeps its reason', async () => {
    const stdout = `${JSON.stringify({ refused: 'unknown-plan', plan: 'nope' })}\n`
    const { run } = fakeRun({
      ok: false,
      stdout: `${stdout}plan refused: unknown-plan — there is no active plan named 'nope' — create it with \`planflow-ai plan compile nope\`\n`,
      error: 'exit 1',
    })
    const answer = await readPlanNotes({ bundledCli: CLI, run }, { rootPath: ROOT, plan: 'nope' })
    expect(answer).toEqual({ ok: false, reason: 'unknown-plan', detail: "There is no active plan named 'nope'." })
    expect(JSON.stringify(answer)).not.toContain('planflow-ai')
  })

  it('reads the refusal line off stderr too', async () => {
    const { run } = fakeRun({ ok: false, stdout: '', stderr: 'plan refused: notes — 2 note(s) need fixing', error: 'exit 1' })
    expect(await readPlanNotes({ bundledCli: CLI, run }, { rootPath: ROOT, plan: 'demo' })).toEqual({
      ok: false,
      reason: 'notes',
      detail: '2 note(s) need fixing.',
    })
  })

  it('answers a timeout, a missing CLI, a bad plan and garbage with fixed sentences — never throws', async () => {
    const timedOut = fakeRun({ ok: false, stdout: '', error: 'timed out' })
    expect(await readPlanNotes({ bundledCli: CLI, run: timedOut.run }, { rootPath: ROOT, plan: 'demo' })).toMatchObject({ ok: false, reason: null })
    expect(await readPlanNotes({ bundledCli: null }, { rootPath: ROOT, plan: 'demo' })).toMatchObject({ ok: false })
    const unused = fakeRun({ ok: true, stdout: '' })
    expect(await readPlanNotes({ bundledCli: CLI, run: unused.run }, { rootPath: ROOT, plan: '--check' })).toMatchObject({ ok: false })
    expect(unused.calls).toHaveLength(0)
    const garbage = fakeRun({ ok: true, stdout: 'not json\n{"half": ' })
    expect(await readPlanNotes({ bundledCli: CLI, run: garbage.run }, { rootPath: ROOT, plan: 'demo' })).toMatchObject({ ok: false, reason: null })
    const throwing = jest.fn(async () => {
      throw new Error('boom')
    }) as unknown as NonNullable<PlanNotesDeps['run']>
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await readPlanNotes({ bundledCli: CLI, run: throwing }, { rootPath: ROOT, plan: 'demo' })).toMatchObject({ ok: false })
    warn.mockRestore()
  })
})

describe('setPlanNote', () => {
  const WRITTEN = { plan: 'demo', path: 'flow/plans/plan_demo_v1.md', changed: true, note: { ...CHANGE_NOTE, status: 'rejected', reason: 'not now' } }

  it('writes a status with its reason through `plan note`, and relays the note as written', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(WRITTEN) })
    const answer = await setPlanNote({ bundledCli: CLI, run }, { rootPath: ROOT, plan: 'demo', note: 1, status: 'rejected', reason: ' not\nnow ' })
    expect(calls[0].args).toEqual(['plan', 'note', 'demo', '--note', '1', '--status', 'rejected', '--reason=not now', '--target', ROOT, '--json'])
    expect(calls[0].options).toEqual({ timeoutMs: PLAN_NOTE_WRITE_TIMEOUT_MS })
    expect(answer).toEqual({ ok: true, ...WRITTEN })
  })

  it('writes a verdict with its sentence, even one that starts with a dash', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(WRITTEN) })
    await setPlanNote({ bundledCli: CLI, run }, { rootPath: ROOT, plan: 'demo', note: 1, verdict: 'differs', why: '--force was needed' })
    expect(calls[0].args).toEqual(['plan', 'note', 'demo', '--note', '1', '--verdict', 'differs', '--why=--force was needed', '--target', ROOT, '--json'])
  })

  it('refuses an impossible request before spawning anything', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(WRITTEN) })
    const deps = { bundledCli: CLI, run }
    expect(await setPlanNote(deps, { rootPath: ROOT, plan: 'demo', note: 1 })).toMatchObject({ ok: false })
    expect(await setPlanNote(deps, { rootPath: ROOT, plan: 'demo', note: 1, status: 'accepted', verdict: 'done', why: 'x' })).toMatchObject({ ok: false })
    expect(await setPlanNote(deps, { rootPath: ROOT, plan: 'demo', note: 1, verdict: 'done', why: '  ' })).toMatchObject({ ok: false })
    expect(await setPlanNote(deps, { rootPath: ROOT, plan: 'demo', note: 0, status: 'accepted' })).toMatchObject({ ok: false })
    expect(await setPlanNote(deps, { rootPath: ROOT, plan: 'demo', note: 1.5, status: 'accepted' })).toMatchObject({ ok: false })
    expect(await setPlanNote(deps, { rootPath: ROOT, plan: 'demo', note: 1, status: 'maybe' as 'accepted' })).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  it('relays a refusal as its sentence, and hides a write failure behind a fixed one', async () => {
    const unknown = fakeRun({
      ok: false,
      stdout: `${JSON.stringify({ refused: 'unknown-note', note: 9 })}\nplan refused: unknown-note — this plan has no note 9\n`,
      error: 'exit 1',
    })
    expect(await setPlanNote({ bundledCli: CLI, run: unknown.run }, { rootPath: ROOT, plan: 'demo', note: 9, status: 'accepted' })).toEqual({
      ok: false,
      reason: 'unknown-note',
      detail: 'This plan has no note 9.',
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failed = fakeRun({
      ok: false,
      stdout: '',
      stderr: 'plan refused: write-failed — the plan file could not be written: EACCES /Users/x/flow/plans/plan_demo_v1.md',
      error: 'exit 1',
    })
    const answer = await setPlanNote({ bundledCli: CLI, run: failed.run }, { rootPath: ROOT, plan: 'demo', note: 1, status: 'accepted' })
    warn.mockRestore()
    expect(answer).toMatchObject({ ok: false, reason: 'write-failed' })
    expect(JSON.stringify(answer)).not.toContain('/Users/')
  })

  it('treats a written answer whose note is malformed as unreadable', async () => {
    const { run } = fakeRun({ ok: true, stdout: JSON.stringify({ ...WRITTEN, note: { n: 1 } }) })
    expect(await setPlanNote({ bundledCli: CLI, run }, { rootPath: ROOT, plan: 'demo', note: 1, status: 'accepted' })).toMatchObject({ ok: false })
  })
})

describe('narrowing', () => {
  it('keeps only valid optional fields; an unknown verdict takes its sentence with it', () => {
    const report = narrowPlanNoteReport({
      ...CHANGE_NOTE,
      what: 3,
      callers: ['a', 1],
      verdict: 'maybe',
      verdictWhy: 'x',
      comments: ['ok', 2],
      quote: { found: 'sometimes' },
      fileMissing: 'yes',
      symbolMissing: true,
    })
    expect(report).not.toBeNull()
    expect(report?.what).toBeUndefined()
    expect(report?.callers).toBeUndefined()
    expect(report?.verdict).toBeUndefined()
    expect(report?.verdictWhy).toBeUndefined()
    expect(report?.comments).toEqual(['ok'])
    expect(report?.quote).toBeUndefined()
    expect(report?.fileMissing).toBeUndefined()
    expect(report?.symbolMissing).toBe(true)
  })

  it('keeps a verdict and its sentence when both are sound', () => {
    expect(narrowPlanNoteReport({ ...CHANGE_NOTE, verdict: 'done', verdictWhy: 'Built as written.' })).toMatchObject({
      verdict: 'done',
      verdictWhy: 'Built as written.',
    })
  })

  it('ignores a refusal payload as an answer', () => {
    expect(parsePlanNotesStdout(JSON.stringify({ refused: 'notes', ...NOTES_ANSWER }))).toBeNull()
  })

  it('counts proposed notes as unreviewed', () => {
    const notes = [
      { ...CHANGE_NOTE, status: 'proposed' },
      { ...CHANGE_NOTE, n: 2, status: 'rejected' },
      { ...CHANGE_NOTE, n: 3, status: 'accepted' },
    ].map((note) => narrowPlanNoteReport(note))
    expect(countPlanNotes(notes.filter((note): note is NonNullable<typeof note> => note !== null))).toEqual({
      total: 3,
      accepted: 1,
      rejected: 1,
      unreviewed: 1,
    })
  })
})

describe('serializePlanNoteWrites — one write per plan at a time', () => {
  const WRITTEN = { plan: 'demo', path: 'flow/plans/plan_demo_v1.md', changed: true, note: { ...CHANGE_NOTE, status: 'accepted' } }
  /** A CLI whose every call waits until the test lets it finish. */
  function gatedRun(): {
    run: NonNullable<PlanNotesDeps['run']>
    log: string[]
    finishNext: () => void
  } {
    const log: string[] = []
    const gates: Array<() => void> = []
    const run = (async (_cli: unknown, _cwd: string, args: readonly string[]) => {
      const note = args[args.indexOf('--note') + 1]
      log.push(`start ${args[2]}#${note}`)
      await new Promise<void>((resolve) => gates.push(resolve))
      log.push(`end ${args[2]}#${note}`)
      return { ok: true, stdout: JSON.stringify(WRITTEN) }
    }) as NonNullable<PlanNotesDeps['run']>
    return { run, log, finishNext: () => gates.shift()?.() }
  }
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('runs two decisions on the same plan one after the other', async () => {
    const { run, log, finishNext } = gatedRun()
    const write = serializePlanNoteWrites((request) => setPlanNote({ bundledCli: CLI, run }, request))
    const first = write({ rootPath: ROOT, plan: 'demo', note: 1, status: 'accepted' })
    const second = write({ rootPath: ROOT, plan: 'demo', note: 2, status: 'rejected' })
    await flush()
    // Positive first: the first write IS running…
    expect(log).toEqual(['start demo#1'])
    finishNext()
    await first
    await flush()
    // …and the second started only after it ended.
    expect(log).toEqual(['start demo#1', 'end demo#1', 'start demo#2'])
    finishNext()
    expect(await second).toMatchObject({ ok: true })
  })

  it('never makes a different plan wait', async () => {
    const { run, log, finishNext } = gatedRun()
    const write = serializePlanNoteWrites((request) => setPlanNote({ bundledCli: CLI, run }, request))
    const a = write({ rootPath: ROOT, plan: 'demo', note: 1, status: 'accepted' })
    const b = write({ rootPath: ROOT, plan: 'other', note: 1, status: 'accepted' })
    await flush()
    expect(log).toEqual(['start demo#1', 'start other#1'])
    finishNext()
    finishNext()
    await Promise.all([a, b])
  })

  it('a failed write does not block the next one', async () => {
    let calls = 0
    const write = serializePlanNoteWrites(async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { ok: false, reason: null, detail: 'x' }
    })
    const first = write({ rootPath: ROOT, plan: 'demo', note: 1, status: 'accepted' })
    const second = write({ rootPath: ROOT, plan: 'demo', note: 2, status: 'accepted' })
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toMatchObject({ ok: false })
  })
})
