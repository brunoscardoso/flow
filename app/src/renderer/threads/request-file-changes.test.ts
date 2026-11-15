import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import {
  addedText,
  fileChangeLabel,
  fileDisplay,
  filesChangedText,
  liveTotalsText,
  removedText,
  requestFileChanges,
} from './request-file-changes'

let next = 0
function call(
  toolName: string,
  input: unknown,
  options: { status?: ToolCallStatus; output?: string | null } = {},
): ToolCallRecord {
  next += 1
  return {
    id: `c${next}`,
    threadId: 't1',
    messageId: null,
    toolName,
    inputJson: JSON.stringify(input),
    outputJson: options.output === undefined || options.output === null ? null : JSON.stringify(options.output),
    status: options.status ?? 'success',
    startedAt: '2026-11-14T10:00:00.000Z',
    completedAt: '2026-11-14T10:00:01.000Z',
  }
}

const edit = (path: string, from: string, to: string, status?: ToolCallStatus): ToolCallRecord =>
  call('Edit', { file_path: path, old_string: from, new_string: to }, { status })
const created = (path: string, content: string): ToolCallRecord =>
  call('Write', { file_path: path, content }, { output: `File created successfully at: ${path}` })
const overwrote = (path: string, content: string): ToolCallRecord =>
  call('Write', { file_path: path, content }, { output: `The file ${path} has been updated successfully.` })
const bash = (): ToolCallRecord => call('Bash', { command: "sed -i '' s/a/b/ /r/x.ts" })

describe('requestFileChanges — one card per file', () => {
  it('sums a file edited several times into one card, in first-touch order', () => {
    const changes = requestFileChanges([
      [edit('/r/src/b.ts', 'a', 'b\nc'), edit('/r/src/a.ts', 'x', 'y')],
      [edit('/r/src/b.ts', 'q\nr\ns', 't')],
    ])
    expect(changes.files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ['/r/src/b.ts', 3, 4],
      ['/r/src/a.ts', 1, 1],
    ])
    expect(changes.added).toBe(4)
    expect(changes.removed).toBe(5)
  })

  it('ignores failed, denied and interrupted edits, and shell commands', () => {
    const changes = requestFileChanges([
      [
        edit('/r/a.ts', 'a', 'b', 'error'),
        edit('/r/b.ts', 'a', 'b', 'denied'),
        edit('/r/c.ts', 'a', 'b', 'interrupted'),
        bash(),
        edit('/r/d.ts', 'a', 'b\nc'),
      ],
    ])
    expect(changes.files.map((file) => file.path)).toEqual(['/r/d.ts'])
  })

  it('a request that changed nothing has no files', () => {
    expect(requestFileChanges([[bash()], []])).toEqual({ files: [], steps: [[], []], added: 0, removed: 0 })
  })
})

describe('requestFileChanges — new files', () => {
  it('a created file is new, and its later edits fold into one net addition', () => {
    const changes = requestFileChanges([
      [created('/r/new.py', 'a\nb\nc\nd\n')],
      [edit('/r/new.py', 'b', 'B1\nB2')],
    ])
    expect(changes.files).toEqual([
      // 4 lines, then 1 replaced by 2: the file has 5 lines, all of them new.
      { path: '/r/new.py', added: 5, removed: 0, counted: true, isNew: true, deleted: false, writing: false },
    ])
  })

  it('an edit of an existing file is never new', () => {
    expect(requestFileChanges([[edit('/r/a.ts', 'a', 'b')]]).files[0]?.isNew).toBe(false)
  })

  it('a write over an existing file adds its lines, removes none it cannot see, and is not new', () => {
    const changes = requestFileChanges([[overwrote('/r/cfg.json', '{\n  "a": 1\n}\n')]])
    expect(changes.files[0]).toMatchObject({ added: 3, removed: 0, isNew: false, counted: true })
  })

  it('a second write of the same file is diffed against the first', () => {
    const changes = requestFileChanges([
      [overwrote('/r/cfg.json', 'a\nb\nc\n')],
      [overwrote('/r/cfg.json', 'a\nB\nc\nd\n')],
    ])
    // 3 (first write, old content unknown) + 2 added / 1 removed (against the first).
    expect(changes.files[0]).toMatchObject({ added: 5, removed: 1, isNew: false })
  })

  it('a write whose result is not here is not called new on a guess', () => {
    const unknown = call('Write', { file_path: '/r/x.ts', content: 'a' })
    expect(requestFileChanges([[unknown]]).files[0]).toMatchObject({ isNew: false, added: 1 })
  })
})

describe('requestFileChanges — every runtime', () => {
  it('folds Claude, Copilot and Codex calls side by side', () => {
    const changes = requestFileChanges([
      [
        call('MultiEdit', { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }),
        call('create', { path: '/r/b.txt', file_text: 'x\ny' }),
        call('apply_patch', { input: '*** Begin Patch\n*** Update File: /r/c.ts\n-x\n+y\n+z\n*** End Patch' }),
        call('Write', { id: 'i1', type: 'file_change', changes: [{ path: '/r/d.md', kind: 'add' }] }),
      ],
    ])
    expect(changes.files.map((file) => [file.path, file.added, file.removed, file.isNew, file.counted])).toEqual([
      ['/r/a.ts', 1, 1, false, true],
      ['/r/b.txt', 2, 0, true, true],
      ['/r/c.ts', 2, 1, false, true],
      ['/r/d.md', 0, 0, true, false],
    ])
    // The Codex file has no numbers, so it adds nothing to the totals.
    expect([changes.added, changes.removed]).toEqual([5, 2])
  })

  it('uses main\'s precomputed counts for a call whose input was summarized', () => {
    const old = {
      ...call('Write', { file_path: '/r/big.ts' }),
      inputWithheld: true,
      outputWithheld: true,
      fileChanges: [{ path: '/r/big.ts', added: 900, removed: 0, counted: true, created: true, whole: true }],
    }
    expect(requestFileChanges([[old]]).files[0]).toMatchObject({ added: 900, isNew: true })
  })
})

describe('requestFileChanges — per step', () => {
  it('each step carries only the files it changed, new where it created them', () => {
    const changes = requestFileChanges([
      [bash()],
      [created('/r/run.py', 'a\nb')],
      [edit('/r/run.py', 'a', 'c'), edit('/r/eval.py', 'x', 'y')],
    ])
    expect(changes.steps.map((step) => step.map((file) => [file.path, file.added, file.removed, file.isNew]))).toEqual([
      [],
      [['/r/run.py', 2, 0, true]],
      [
        ['/r/run.py', 1, 1, false],
        ['/r/eval.py', 1, 1, false],
      ],
    ])
  })
})

describe('requestFileChanges — writing…', () => {
  it('marks the file the newest call is still writing, with its predicted lines', () => {
    const running = call('Write', { file_path: '/r/run.py', content: 'a\nb\nc' }, { status: 'running' })
    const changes = requestFileChanges([[edit('/r/a.ts', 'a', 'b'), running]], { live: true })
    expect(changes.files.map((file) => [file.path, file.writing, file.added])).toEqual([
      ['/r/a.ts', false, 1],
      ['/r/run.py', true, 3],
    ])
  })

  it('is never shown for a request that is not live, nor for an older call still marked running', () => {
    const running = call('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, { status: 'running' })
    expect(requestFileChanges([[running]]).files).toEqual([])
    const settled = requestFileChanges([[running, bash()]], { live: true })
    expect(settled.files).toEqual([])
  })

  it('a running call on a file already changed highlights that card', () => {
    const changes = requestFileChanges(
      [[edit('/r/a.ts', 'a', 'b'), call('Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y\nz' }, { status: 'running' })]],
      { live: true },
    )
    expect(changes.files).toEqual([
      { path: '/r/a.ts', added: 3, removed: 2, counted: true, isNew: false, deleted: false, writing: true },
    ])
  })
})

describe('the words', () => {
  it('numbers, with a real minus sign and nothing for zero', () => {
    expect(addedText(156)).toBe('+156')
    expect(removedText(34)).toBe('−34')
    expect(addedText(0)).toBe('')
    expect(removedText(0)).toBe('')
  })

  it('the header and the work row say files changed', () => {
    expect(filesChangedText(1)).toBe('1 file changed')
    expect(filesChangedText(3)).toBe('3 files changed')
  })

  it('the live total: +180 −40 in 2 files', () => {
    const changes = requestFileChanges([[edit('/r/a.ts', 'a\nb', 'c\nd\ne'), edit('/r/b.ts', '', 'x')]])
    expect(liveTotalsText(changes)).toBe('+4 −2 in 2 files')
    expect(liveTotalsText({ files: [], added: 0, removed: 0 })).toBe('')
    const codex = requestFileChanges([[call('Write', { type: 'file_change', changes: [{ path: '/r/x', kind: 'update' }] })]])
    expect(liveTotalsText(codex)).toBe('in 1 file')
  })

  it('a card\'s accessible name says everything it shows', () => {
    const [file] = requestFileChanges([[created('/r/src/run.py', 'a\nb')]]).files
    expect(file).toBeDefined()
    if (file === undefined) return
    expect(fileChangeLabel(file, fileDisplay(file.path, ['/r']))).toBe('run.py in src, 2 lines added, 0 removed, new')
  })
})

describe('fileDisplay — name, folder and root', () => {
  it('names the folder relative to the longest root holding the file', () => {
    expect(fileDisplay('/repo/src/training/train_model.py', ['/repo', '/repo/src'])).toEqual({
      name: 'train_model.py',
      folder: 'training',
      root: '/repo/src',
      relative: 'training/train_model.py',
    })
    expect(fileDisplay('/repo/README.md', ['/repo/'])).toEqual({ name: 'README.md', folder: '', root: '/repo', relative: 'README.md' })
  })

  it('a root is a whole folder, not a prefix of a name', () => {
    expect(fileDisplay('/repo-other/a.ts', ['/repo']).root).toBeNull()
  })

  it('a file under no root keeps its whole folder', () => {
    expect(fileDisplay('/tmp/x/a.ts', ['/repo'])).toEqual({ name: 'a.ts', folder: '/tmp/x', root: null, relative: '/tmp/x/a.ts' })
  })

  it('a relative path is relative to the first root', () => {
    expect(fileDisplay('src/new.ts', ['/repo', '/other'])).toEqual({ name: 'new.ts', folder: 'src', root: '/repo', relative: 'src/new.ts' })
  })
})
