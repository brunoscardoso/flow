import { existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, jest } from '@jest/globals'

import type { CliRunResult } from '../agent/learn-session'
import {
  STORYLINE_TIMEOUT_MS,
  parseStorylineStdout,
  resolveTreeSitterPath,
  resolveTypeScriptPath,
  runStoryline,
  shareStorylineRuns,
  type StorylineDeps,
} from './storyline-runner'

const CLI = { execPath: '/electron', cliPath: '/bundle/planflow-ai.mjs' }
const ROOT = '/repo'
const TS_PATH = '/app/node_modules/typescript/lib/typescript.js'

const RESULT = {
  ok: true,
  scope: 'file',
  files: ['src/a.ts'],
  language: 'typescript',
  pieces: [],
  calls: [],
  typeUses: [],
  entries: [],
  classes: [],
}

interface Call {
  cwd: string
  args: readonly string[]
  options: { timeoutMs?: number; env?: Record<string, string> } | undefined
}

function fakeRun(answer: CliRunResult): { run: NonNullable<StorylineDeps['run']>; calls: Call[] } {
  const calls: Call[] = []
  const run = jest.fn(async (_cli: unknown, cwd: string, args: readonly string[], options?: Call['options']) => {
    calls.push({ cwd, args, options })
    return answer
  }) as unknown as NonNullable<StorylineDeps['run']>
  return { run, calls }
}

describe('runStoryline', () => {
  it('runs the verb for a file with the app compiler path, and relays the answer', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: `${JSON.stringify(RESULT)}\n` })
    const answer = await runStoryline({ bundledCli: CLI, run, typescriptPath: TS_PATH }, { rootId: ROOT, file: 'src/a.ts' })
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(ROOT)
    expect(calls[0].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--file', 'src/a.ts', '--json'])
    expect(calls[0].options).toEqual({ timeoutMs: STORYLINE_TIMEOUT_MS, env: { FLOW_TYPESCRIPT_PATH: TS_PATH } })
    expect(answer).toEqual(RESULT)
  })

  it('passes the app tree-sitter package beside the compiler, each only when known', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(RESULT) })
    await runStoryline({ bundledCli: CLI, run, typescriptPath: TS_PATH, treeSitterPath: '/app/ts-wasm' }, { rootId: ROOT, file: 'x.py' })
    await runStoryline({ bundledCli: CLI, run, typescriptPath: null, treeSitterPath: '/app/ts-wasm' }, { rootId: ROOT, file: 'x.py' })
    expect(calls[0].options).toEqual({
      timeoutMs: STORYLINE_TIMEOUT_MS,
      env: { FLOW_TYPESCRIPT_PATH: TS_PATH, FLOW_TREESITTER_PATH: '/app/ts-wasm' },
    })
    expect(calls[1].options).toEqual({ timeoutMs: STORYLINE_TIMEOUT_MS, env: { FLOW_TREESITTER_PATH: '/app/ts-wasm' } })
  })

  it('passes --part for a part, and no env when the compiler path is unknown', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(RESULT) })
    await runStoryline({ bundledCli: CLI, run, typescriptPath: null }, { rootId: ROOT, partRef: 'chats/composer' })
    expect(calls[0].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--part', 'chats/composer', '--json'])
    expect(calls[0].options).toEqual({ timeoutMs: STORYLINE_TIMEOUT_MS })
  })

  it('refuses both or neither subject without running anything', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(RESULT) })
    const both = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts', partRef: 'x/y' })
    const neither = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT })
    expect(both).toMatchObject({ ok: false, reason: 'not-found' })
    expect(neither).toMatchObject({ ok: false, reason: 'not-found' })
    expect(calls).toEqual([])
  })

  it('answers no-compiler when there is no bundled CLI', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(RESULT) })
    const answer = await runStoryline({ bundledCli: null, run }, { rootId: ROOT, file: 'a.ts' })
    expect(answer).toEqual({ ok: false, reason: 'no-compiler', sentence: "Flow couldn't start its code reader." })
    expect(calls).toEqual([])
  })

  it('relays an exit-0 refusal answer as-is', async () => {
    const refusal = { ok: false, reason: 'syntax-error', sentence: 'This file does not parse.', text: 'x', file: 'a.ts' }
    const { run } = fakeRun({ ok: true, stdout: JSON.stringify(refusal) })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts' })).toEqual(refusal)
  })

  it('takes the last JSON answer line, ignoring noise before it', async () => {
    const stdout = ['warming up', '{not json', '{"ok":"maybe"}', JSON.stringify(RESULT), ''].join('\n')
    const { run } = fakeRun({ ok: true, stdout })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts' })).toEqual(RESULT)
  })

  it('relays an argument refusal sentence from the transcript', async () => {
    const { run } = fakeRun({
      ok: false,
      stdout: 'storyline refused: not-found — That file is not in this project.\n',
      error: 'exited with 1',
    })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'nope.ts' })).toEqual({
      ok: false,
      reason: 'not-found',
      sentence: 'That file is not in this project.',
    })
  })

  it('maps an unknown refusal reason to not-found, with the generic sentence rather than the raw line', async () => {
    const { run } = fakeRun({ ok: false, stdout: '', stderr: 'storyline refused: bad-args — Pick one --flag.', error: 'x' })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts' })).toEqual({
      ok: false,
      reason: 'not-found',
      sentence: "Flow couldn't read this as a story.",
    })
  })

  it.each([
    ['unknown-part', "no feature or part named 'feature:gone/part'", "Flow couldn't find this part any more."],
    ['knowledge-unreadable', "no features could be read for 'feature:gone/part'", "Flow couldn't read this project's features just now."],
    ['outside-project', "'../../etc/passwd' is not inside the project", "That file isn't part of this project."],
    ['no-target', "'/Users/someone/repo' is not a folder", "Flow couldn't find this project."],
    ['arguments', 'pass exactly one of --file <path> or --part <feature-ref>', 'Pick one file or one part to read as a story.'],
  ])('turns the %s argument refusal into a fixed sentence with no ref, path or flag in it', async (reason, raw, sentence) => {
    const { run } = fakeRun({ ok: false, stdout: `storyline refused: ${reason} — ${raw}\n`, error: 'exited with 1' })
    const answer = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, partRef: 'feature:gone/part' })
    expect(answer).toEqual({ ok: false, reason: 'not-found', sentence })
    if (!answer.ok) {
      expect(answer.sentence).not.toContain(raw)
      expect(answer.sentence).not.toContain('--')
    }
  })

  it('turns non-JSON output into a refusal', async () => {
    const { run } = fakeRun({ ok: true, stdout: 'something odd\n' })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
  })

  it('turns a timeout into a too-large refusal', async () => {
    const { run } = fakeRun({ ok: false, stdout: '', error: 'timed out' })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts' })).toEqual({
      ok: false,
      reason: 'too-large',
      sentence: 'This took too long to read as a story.',
    })
  })

  it('never throws when an injected runner rejects', async () => {
    const run = (async () => {
      throw new Error('boom')
    }) as unknown as NonNullable<StorylineDeps['run']>
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'a.ts' })).resolves.toMatchObject({ ok: false })
    warn.mockRestore()
  })
})

describe('runStoryline in a plan context', () => {
  const COMPARE = {
    plan: 'story-today-after',
    base: 'abc123',
    baseSource: 'run',
    pieces: { 'src/a.ts#a': 'changed' },
    removed: [],
    hunks: { 'src/a.ts#a': [{ todayStart: 1, afterStart: 1, lines: [{ op: 'added', text: 'x' }] }] },
    hiddenLines: {},
    unreadable: [],
    predicted: [],
    summary: { changed: 1, added: 0, removed: 0, predicted: 0, planned: 0 },
  }

  it('passes --plan, and --base when the board names one', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, compare: COMPARE }) })
    const answer = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, partRef: 'blueprint/story', plan: 'story-today-after', base: 'abc123' })
    expect(calls[0].args).toEqual([
      'blueprint', 'storyline', '--target', ROOT, '--part', 'blueprint/story', '--plan', 'story-today-after', '--base', 'abc123', '--json',
    ])
    expect(answer).toEqual({ ...RESULT, compare: COMPARE })
  })

  it('passes --plan alone when no base is known, and nothing for a blank plan', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(RESULT) })
    await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: 'x' })
    await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: '  ', base: 'abc' })
    expect(calls[0].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--file', 'src/a.ts', '--plan', 'x', '--json'])
    expect(calls[1].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--file', 'src/a.ts', '--json'])
  })

  it("asks for a plan's own story with --plan alone, and refuses neither subject for a blank or flag-like plan", async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, scope: 'part', compare: COMPARE }) })
    const answer = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, plan: 'summarize-x', base: 'abc123' })
    expect(calls[0].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--plan', 'summarize-x', '--base', 'abc123', '--json'])
    expect(answer).toEqual({ ...RESULT, scope: 'part', compare: COMPARE })
    const blank = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, plan: '  ' })
    const flagLike = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, plan: '--file' })
    expect(blank).toMatchObject({ ok: false, reason: 'not-found' })
    expect(flagLike).toMatchObject({ ok: false, reason: 'not-found' })
    expect(calls).toHaveLength(1)
  })

  it('never passes a value that reads as another flag', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: JSON.stringify(RESULT) })
    await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: '--json', base: '--evil' })
    await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p', base: '-x' })
    expect(calls[0].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--file', 'src/a.ts', '--json'])
    expect(calls[1].args).toEqual(['blueprint', 'storyline', '--target', ROOT, '--file', 'src/a.ts', '--plan', 'p', '--json'])
  })

  it('drops a malformed compare and keeps the story', async () => {
    const { run } = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, compare: { plan: 'p', pieces: [] } }) })
    const answer = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p' })
    expect(answer).toEqual(RESULT)
  })

  it('relays a compareNote untouched', async () => {
    const note = "Flow couldn't find an active plan named p, so this story has no Today and After."
    const { run } = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, compareNote: note }) })
    expect(await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p' })).toEqual({ ...RESULT, compareNote: note })
  })
})

describe('runStoryline with change notes', () => {
  const NOTE = {
    n: 1,
    phase: 2,
    kind: 'change',
    target: 'file:src/a.ts:a',
    file: 'src/a.ts',
    symbol: 'a',
    what: 'Return the count.',
    status: 'accepted',
    comments: [],
  }
  const PHASE_PREDICTION = { pieceId: 'src/a.ts#a', file: 'src/a.ts', symbol: 'a', phase: 1, task: 'Edit a', kind: 'changes' }
  const NOTE_CHANGE = {
    kind: 'note-change',
    file: 'src/a.ts',
    note: NOTE,
    pieceId: 'src/a.ts#a',
    symbol: 'a',
    quoteLines: { startLine: 3, endLine: 4 },
    fact: 'changed',
  }
  const NOTE_NEW = {
    kind: 'note-new',
    file: 'api/src/b.ts',
    project: 'api',
    codeUnavailable: true,
    note: { ...NOTE, n: 2, kind: 'new', target: 'api/file:src/b.ts:make', project: 'api', file: 'src/b.ts', symbol: 'make', status: 'proposed' },
    symbol: 'make',
    signature: 'make(): string',
    purpose: 'Builds the label.',
    callers: ['a'],
    callerPieces: { a: 'src/a.ts#a' },
  }
  const NOTE_FILE = {
    kind: 'note-file',
    file: 'src/routes.ts',
    note: { ...NOTE, n: 3, kind: 'file', target: 'file:src/routes.ts', file: 'src/routes.ts', symbol: undefined },
    fileMissing: true,
  }
  const COMPARE = {
    plan: 'p',
    base: null,
    baseSource: null,
    pieces: {},
    removed: [],
    hunks: {},
    hiddenLines: {},
    unreadable: [],
    predicted: [PHASE_PREDICTION, NOTE_CHANGE, NOTE_NEW, NOTE_FILE],
    summary: { changed: 0, added: 0, removed: 0, predicted: 2, planned: 2 },
  }
  const BANDS = [
    { project: null, files: ['src/a.ts', 'src/routes.ts'] },
    { project: 'api', colorIndex: 2, files: ['api/src/b.ts'] },
  ]

  it('relays note predictions, the old phase predictions and the bands as they are', async () => {
    const { run } = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, compare: COMPARE, bands: BANDS }) })
    const answer = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p' })
    expect(answer).toEqual({ ...RESULT, compare: JSON.parse(JSON.stringify(COMPARE)), bands: BANDS })
  })

  it('drops a malformed prediction, keeps the rest, and leaves out a bad optional field', async () => {
    const predicted = [
      PHASE_PREDICTION,
      { ...PHASE_PREDICTION, task: 3 },
      { ...NOTE_CHANGE, note: { ...NOTE, status: 'maybe' } },
      { ...NOTE_CHANGE, symbol: undefined },
      { ...NOTE_NEW, callers: 'a' },
      { kind: 'note-other', file: 'x', note: NOTE },
      'nope',
      { ...NOTE_CHANGE, fact: 'sideways', quoteLines: { startLine: 5, endLine: 2 }, quoteCount: -1 },
      NOTE_FILE,
    ]
    const { run } = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, compare: { ...COMPARE, predicted } }) })
    const answer = await runStoryline({ bundledCli: CLI, run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p' })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    const kinds = answer.compare?.predicted.map((prediction) => prediction.kind)
    expect(kinds).toEqual(['changes', 'note-change', 'note-file'])
    const change = answer.compare?.predicted[1]
    expect(change).toMatchObject({ kind: 'note-change', symbol: 'a' })
    expect(change).not.toHaveProperty('fact')
    expect(change).not.toHaveProperty('quoteLines')
    expect(change).not.toHaveProperty('quoteCount')
  })

  it('drops malformed bands one by one, and a bands that is not a list whole', async () => {
    const bands = [...BANDS, { project: 3, files: [] }, { project: 'web', files: 'a' }, { project: '', files: [] }]
    const listed = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, bands }) })
    expect(await runStoryline({ bundledCli: CLI, run: listed.run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p' })).toEqual({ ...RESULT, bands: BANDS })
    const broken = fakeRun({ ok: true, stdout: JSON.stringify({ ...RESULT, bands: { project: null } }) })
    expect(await runStoryline({ bundledCli: CLI, run: broken.run }, { rootId: ROOT, file: 'src/a.ts', plan: 'p' })).toEqual(RESULT)
  })
})

describe('parseStorylineStdout', () => {
  it('rejects a result missing its arrays and a refusal missing its sentence', () => {
    expect(parseStorylineStdout(JSON.stringify({ ok: true, files: [] }))).toBeNull()
    expect(parseStorylineStdout(JSON.stringify({ ok: false, reason: 'not-found' }))).toBeNull()
  })
})

describe('resolveTypeScriptPath', () => {
  it('returns the resolved path, or null when the module is absent', () => {
    expect(resolveTypeScriptPath(() => TS_PATH)).toBe(TS_PATH)
    expect(
      resolveTypeScriptPath(() => {
        throw new Error('Cannot find module')
      }),
    ).toBeNull()
  })

  it('finds the app own copy by default', () => {
    expect(resolveTypeScriptPath()).toMatch(/typescript[/\\]lib[/\\]typescript\.js$/)
  })
})

describe('resolveTreeSitterPath', () => {
  it('returns the package directory, or null when the package is absent', () => {
    expect(resolveTreeSitterPath(() => '/app/node_modules/@vscode/tree-sitter-wasm/package.json')).toBe(
      '/app/node_modules/@vscode/tree-sitter-wasm',
    )
    expect(
      resolveTreeSitterPath(() => {
        throw new Error('Cannot find module')
      }),
    ).toBeNull()
  })

  it('finds the app own copy, with its grammars, by default', () => {
    const found = resolveTreeSitterPath()
    expect(found).toMatch(/@vscode[/\\]tree-sitter-wasm$/)
    expect(existsSync(join(found as string, 'wasm', 'tree-sitter-python.wasm'))).toBe(true)
  })
})

describe('shareStorylineRuns — one cold run per identical request in flight', () => {
  it('two concurrent asks for the same story spawn ONE CLI run and get the same answer', async () => {
    const spawned: string[][] = []
    const gates: Array<() => void> = []
    const release = (): void => gates.shift()?.()
    const run = (async (_cli: unknown, _cwd: string, args: readonly string[]) => {
      spawned.push([...args])
      await new Promise<void>((resolve) => gates.push(resolve))
      return { ok: true, stdout: JSON.stringify({ ok: true, files: [], pieces: [], calls: [], typeUses: [], entries: [], classes: [] }) }
    }) as NonNullable<StorylineDeps['run']>
    const story = shareStorylineRuns((request) => runStoryline({ bundledCli: CLI, run }, request))
    const first = story({ rootId: ROOT, file: 'src/a.ts' })
    const second = story({ rootId: ROOT, file: 'src/a.ts' })
    const other = story({ rootId: ROOT, file: 'src/b.ts' })
    await new Promise((resolve) => setImmediate(resolve))
    // Positive first: a run did start — and only one per distinct story.
    expect(spawned.map((args) => args[args.indexOf('--file') + 1])).toEqual(['src/a.ts', 'src/b.ts'])
    release()
    release()
    const [a1, a2] = await Promise.all([first, second])
    expect(a1).toBe(a2)
    expect(a1.ok).toBe(true)
    await other
  })

  it('forgets a run once it settles, so the next ask reads today\'s code', async () => {
    let spawns = 0
    const story = shareStorylineRuns(async () => {
      spawns += 1
      return { ok: false, reason: 'not-found', sentence: 'x' }
    })
    await story({ rootId: ROOT, file: 'src/a.ts' })
    await story({ rootId: ROOT, file: 'src/a.ts' })
    expect(spawns).toBe(2)
  })
})
