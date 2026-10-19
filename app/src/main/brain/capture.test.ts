// Working-set capture tests (#52, Phase 2). The derivation is pure; the writer
// is exercised against a real temp dir with a stubbed tool-call source.

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  captureThreadWorkingSet,
  deriveWorkingSet,
  makeBrainCaptureOnTurnComplete,
  parseToolCalls,
  threadWorkingSet,
  type RawToolCall,
} from './capture'
import { runCompaction } from './compaction'
import { BRAIN_SUBDIRS } from './store'

function call(toolName: string, input: unknown): RawToolCall {
  return { toolName, inputJson: JSON.stringify(input) }
}

const ROOT = '/work/project'

describe('deriveWorkingSet', () => {
  it('classifies edits and reads, root-relative, deduped and sorted', () => {
    const files = deriveWorkingSet(ROOT, parseToolCalls([
      call('Read', { file_path: `${ROOT}/src/b.ts` }),
      call('Edit', { file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y' }),
      call('Write', { file_path: 'src/c.ts', content: 'hi' }), // relative input
    ]))
    expect(files).toEqual([
      { path: 'src/a.ts', role: 'edited' },
      { path: 'src/b.ts', role: 'read' },
      { path: 'src/c.ts', role: 'edited' },
    ])
  })

  it('lets "edited" win over "read" for the same file regardless of order', () => {
    const files = deriveWorkingSet(ROOT, parseToolCalls([
      call('Read', { file_path: `${ROOT}/src/a.ts` }),
      call('Edit', { file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y' }),
      call('Read', { file_path: `${ROOT}/src/a.ts` }),
    ]))
    expect(files).toEqual([{ path: 'src/a.ts', role: 'edited' }])
  })

  it('ignores non-file tools and never captures their content (NFR5)', () => {
    const files = deriveWorkingSet(ROOT, parseToolCalls([
      call('Bash', { command: 'export TOKEN=supersecret && curl ...' }),
      call('Grep', { pattern: 'password', path: `${ROOT}/src` }),
      call('Read', { file_path: `${ROOT}/src/a.ts` }),
    ]))
    expect(files).toEqual([{ path: 'src/a.ts', role: 'read' }])
    // The serialized result must not carry any secret value.
    expect(JSON.stringify(files)).not.toContain('supersecret')
  })

  it('drops files outside the root and obvious secret files', () => {
    const files = deriveWorkingSet(ROOT, parseToolCalls([
      call('Read', { file_path: '/etc/passwd' }),
      call('Read', { file_path: `${ROOT}/../other/x.ts` }),
      call('Read', { file_path: `${ROOT}/.env` }),
      call('Read', { file_path: `${ROOT}/deploy/prod.pem` }),
      call('Read', { file_path: `${ROOT}/src/ok.ts` }),
    ]))
    expect(files).toEqual([{ path: 'src/ok.ts', role: 'read' }])
  })
})

describe('parseToolCalls', () => {
  it('skips malformed and empty input JSON', () => {
    expect(
      parseToolCalls([
        { toolName: 'Read', inputJson: null },
        { toolName: 'Read', inputJson: '{ not json' },
        { toolName: 'Read', inputJson: '"a string"' },
        { toolName: 'Read', inputJson: '{"file_path":"/x"}' },
      ]),
    ).toHaveLength(1)
  })
})

describe('captureThreadWorkingSet', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  const deps = {
    threadTitle: () => 'Add feature X',
    now: () => '2026-07-13T00:00:00.000Z',
  }
  // The writer is handed the working set, already derived against the work root.
  const filesOf = (root: string, calls: RawToolCall[]) =>
    deriveWorkingSet(root, parseToolCalls(calls))

  it('writes a raw record under flow/brain/.raw and reports the count', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-cap-'))
    const result = await captureThreadWorkingSet(
      deps,
      dir,
      'thread-1',
      filesOf(dir, [call('Edit', { file_path: `${dir}/src/a.ts`, old_string: 'x', new_string: 'y' })]),
    )
    expect(result).toEqual({
      captured: true,
      rawPath: 'flow/brain/.raw/thread-1.json',
      fileCount: 1,
    })
    const written = JSON.parse(readFileSync(join(dir, 'flow/brain/.raw/thread-1.json'), 'utf8'))
    expect(written).toMatchObject({
      threadId: 'thread-1',
      title: 'Add feature X',
      files: [{ path: 'src/a.ts', role: 'edited' }],
      capturedAt: '2026-07-13T00:00:00.000Z',
    })
  })

  it('writes nothing when the thread touched no files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-cap-'))
    const result = await captureThreadWorkingSet(
      deps,
      dir,
      'thread-2',
      filesOf(dir, [call('Bash', { command: 'ls' })]),
    )
    expect(result).toEqual({ captured: false, fileCount: 0 })
    expect(existsSync(join(dir, 'flow/brain/.raw/thread-2.json'))).toBe(false)
  })
})

describe('makeBrainCaptureOnTurnComplete', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  function source(root: string, calls: RawToolCall[]) {
    return {
      getThread: (id: string) =>
        id === 'thread-1' ? { projectRoot: root, worktreePath: null, title: 'T' } : null,
      // What the store hands over now: the touched path per call, extracted in
      // SQL, never the input a Write carried.
      listToolCallPaths: () =>
        parseToolCalls(calls).map(({ toolName, input }) => ({
          toolName,
          filePath:
            typeof input.file_path === 'string'
              ? input.file_path
              : typeof input.notebook_path === 'string'
                ? input.notebook_path
                : null,
        })),
    }
  }

  /** Await the handler's in-flight capture→compaction work deterministically. */
  function trackedHandler(
    calls: RawToolCall[],
    compact: (root: string) => Promise<unknown> = (root) => runCompaction(root),
  ): { handler: (id: string, ok: boolean) => void; settled: () => Promise<unknown> } {
    let work: Promise<unknown> = Promise.resolve()
    const handler = makeBrainCaptureOnTurnComplete(
      source(dir, calls),
      () => '2026-07-13T00:00:00.000Z',
      compact,
      (w) => {
        work = w
      },
    )
    return { handler, settled: () => work }
  }

  it('captures on a successful turn (compaction stubbed to isolate the write)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-turn-'))
    const { handler, settled } = trackedHandler(
      [call('Edit', { file_path: `${dir}/a.ts`, old_string: 'x', new_string: 'y' })],
      async () => undefined,
    )
    handler('thread-1', true)
    await settled()
    expect(existsSync(join(dir, 'flow/brain/.raw/thread-1.json'))).toBe(true)
  })

  it('chains compaction after capture — promotes to features/ and consumes .raw', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-turn-'))
    const { handler, settled } = trackedHandler([
      call('Edit', { file_path: `${dir}/a.ts`, old_string: 'x', new_string: 'y' }),
    ])
    handler('thread-1', true)
    await settled()
    expect(existsSync(join(dir, 'flow/brain/features/t.md'))).toBe(true)
    expect(existsSync(join(dir, 'flow/brain/.raw/thread-1.json'))).toBe(false) // consumed
  })

  it('does nothing on a failed turn or unknown thread', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-turn-'))
    const { handler, settled } = trackedHandler(
      [call('Edit', { file_path: `${dir}/a.ts`, old_string: 'x', new_string: 'y' })],
      async () => undefined,
    )
    handler('thread-1', false)
    handler('missing', true)
    await settled()
    expect(existsSync(join(dir, 'flow/brain/.raw/thread-1.json'))).toBe(false)
  })
})

// A thread with its own worktree has TWO roots: its tool calls wrote under the
// WORK root (its worktree), while the brain it feeds lives under the PROJECT root.
describe('worktree threads (worktreePath set)', () => {
  const PROJECT = '/repo/project'
  const WORKTREE = '/repo/.worktrees/feat-x'
  const worktreeThread = { projectRoot: PROJECT, worktreePath: WORKTREE }

  it('threadWorkingSet resolves paths against the worktree, repo-relative with roles', () => {
    const files = threadWorkingSet(worktreeThread, [
      { toolName: 'Edit', filePath: `${WORKTREE}/src/a.ts` },
      { toolName: 'Read', filePath: `${WORKTREE}/src/b.ts` },
      { toolName: 'Bash', filePath: null },
      // Under the PROJECT root, not the worktree — this thread did not work there.
      { toolName: 'Edit', filePath: `${PROJECT}/src/elsewhere.ts` },
    ])
    expect(files).toEqual([
      { path: 'src/a.ts', role: 'edited' },
      { path: 'src/b.ts', role: 'read' },
    ])
  })

  describe('makeBrainCaptureOnTurnComplete end-to-end', () => {
    let projectDir: string
    let worktreeDir: string
    afterEach(() => {
      for (const d of [projectDir, worktreeDir]) if (d) rmSync(d, { recursive: true, force: true })
    })

    it('reads paths off the worktree and writes the record + compaction to the project', async () => {
      projectDir = mkdtempSync(join(tmpdir(), 'brain-proj-'))
      worktreeDir = mkdtempSync(join(tmpdir(), 'brain-wt-'))
      const compactRoot = jest.fn(async (_root: string) => undefined)
      let work: Promise<unknown> = Promise.resolve()
      const handler = makeBrainCaptureOnTurnComplete(
        {
          getThread: (id) =>
            id === 'thread-w'
              ? { projectRoot: projectDir, worktreePath: worktreeDir, title: 'Worktree run' }
              : null,
          listToolCallPaths: () => [
            { toolName: 'Edit', filePath: join(worktreeDir, 'src', 'a.ts') },
            { toolName: 'Read', filePath: join(worktreeDir, 'docs', 'b.md') },
          ],
        },
        () => '2026-09-30T00:00:00.000Z',
        compactRoot,
        (w) => {
          work = w
        },
      )

      handler('thread-w', true)
      await work

      const rawRel = `${BRAIN_SUBDIRS.raw}/thread-w.json`
      const projectRaw = join(projectDir, rawRel)
      // Positive first: a record exists and it carries the worktree's files.
      expect(existsSync(projectRaw)).toBe(true)
      const record = JSON.parse(readFileSync(projectRaw, 'utf8'))
      expect(record.files).toEqual([
        { path: 'docs/b.md', role: 'read' },
        { path: 'src/a.ts', role: 'edited' },
      ])
      // …then: the store is the project's, never the worktree's.
      expect(existsSync(join(worktreeDir, rawRel))).toBe(false)
      expect(compactRoot).toHaveBeenCalledTimes(1)
      expect(compactRoot).toHaveBeenCalledWith(projectDir)
    })
  })
})
