import type { ToolCallRecord } from './ipc-contract'
import {
  countsAsChange,
  isFileChangeTool,
  lineArrayDiffCounts,
  lineDiffCounts,
  patchChanges,
  splitLines,
  toolCallFileChanges,
  writeCreatedFile,
} from './tool-file-changes'

function call(toolName: string, input: unknown, output: string | null = null): ToolCallRecord {
  return {
    id: 'c1',
    threadId: 't1',
    messageId: null,
    toolName,
    inputJson: typeof input === 'string' ? input : JSON.stringify(input),
    outputJson: output === null ? null : JSON.stringify(output),
    status: 'success',
    startedAt: '2026-11-14T10:00:00.000Z',
    completedAt: '2026-11-14T10:00:01.000Z',
  }
}

describe('splitLines', () => {
  it('counts no lines in an empty text, and a trailing newline ends a line', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('\n')).toEqual([''])
  })
})

describe('lineDiffCounts — a real line diff', () => {
  it('empty to empty, and identical texts, change nothing', () => {
    expect(lineDiffCounts('', '')).toEqual({ added: 0, removed: 0 })
    expect(lineDiffCounts('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 })
  })

  it('all new and all removed', () => {
    expect(lineDiffCounts('', 'a\nb\nc\n')).toEqual({ added: 3, removed: 0 })
    expect(lineDiffCounts('a\nb', '')).toEqual({ added: 0, removed: 2 })
  })

  it('one changed line is one removed and one added', () => {
    expect(lineDiffCounts('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
  })

  it('an insertion in the middle is only an addition', () => {
    expect(lineDiffCounts('a\nb\nc', 'a\nb\nx\ny\nc')).toEqual({ added: 2, removed: 0 })
  })

  it('finds the common lines a prefix/suffix trim would miss', () => {
    // Trimming alone would count 4 removed + 4 added: nothing is shared at the ends.
    expect(lineDiffCounts('x\na\nb\ny', 'p\na\nb\nq')).toEqual({ added: 2, removed: 2 })
    // A moved line: one line out, one line in — the rest is common.
    expect(lineDiffCounts('a\nb\nc\nd', 'b\nc\nd\na')).toEqual({ added: 1, removed: 1 })
  })

  it('is the minimal edit: added − removed is always the line delta', () => {
    const before = ['import a', 'const x = 1', '', 'function f() {', '  return x', '}']
    const after = ['import a', 'import b', 'const x = 2', '', 'function f() {', '  return x + 1', '}', '']
    const counts = lineArrayDiffCounts(before, after)
    expect(counts.added - counts.removed).toBe(after.length - before.length)
    expect(counts).toEqual({ added: 4, removed: 2 })
  })

  it('stays bounded on a huge rewrite: the honest upper bound, never a made-up saving', () => {
    const before = Array.from({ length: 6_000 }, (_, i) => `old ${i}`)
    const after = Array.from({ length: 6_000 }, (_, i) => `new ${i}`)
    const started = Date.now()
    expect(lineArrayDiffCounts(before, after)).toEqual({ added: 6_000, removed: 6_000 })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('writeCreatedFile — read from the write result', () => {
  it('tells a created file from an updated one, and says nothing without a result', () => {
    expect(writeCreatedFile(JSON.stringify('File created successfully at: /r/a.ts'))).toBe(true)
    expect(writeCreatedFile(JSON.stringify('The file /r/a.ts has been updated successfully.'))).toBe(false)
    expect(writeCreatedFile(null)).toBeNull()
    expect(writeCreatedFile(JSON.stringify('something else'))).toBeNull()
    // The head main reads from SQLite is a cut JSON string — still readable.
    expect(writeCreatedFile('"File created successfully at: /r/very/long/pa')).toBe(true)
  })
})

describe('toolCallFileChanges — Claude', () => {
  it('Edit: a line diff of old_string to new_string, not a new file', () => {
    expect(toolCallFileChanges(call('Edit', { file_path: '/r/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }))).toEqual([
      { path: '/r/a.ts', added: 2, removed: 1, counted: true, created: false },
    ])
  })

  it('MultiEdit: the sum of its edits', () => {
    const input = {
      file_path: '/r/a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'x', new_string: 'x\ny\nz' },
      ],
    }
    expect(toolCallFileChanges(call('MultiEdit', input))).toEqual([
      { path: '/r/a.ts', added: 3, removed: 1, counted: true, created: false },
    ])
  })

  it('Write: every line added; new or not comes from its own result', () => {
    const input = { file_path: '/r/n.py', content: 'a\nb\nc\n' }
    expect(toolCallFileChanges(call('Write', input, 'File created successfully at: /r/n.py'))).toEqual([
      { path: '/r/n.py', added: 3, removed: 0, counted: true, created: true, whole: true },
    ])
    expect(toolCallFileChanges(call('Write', input, 'The file /r/n.py has been updated successfully.'))[0]?.created).toBe(false)
    expect(toolCallFileChanges(call('Write', input))[0]?.created).toBeNull()
  })

  it('NotebookEdit: the new cell is added', () => {
    expect(toolCallFileChanges(call('NotebookEdit', { notebook_path: '/r/n.ipynb', new_source: 'x = 1\ny = 2' }))).toEqual([
      { path: '/r/n.ipynb', added: 2, removed: 0, counted: true, created: false },
    ])
  })

  it('ignores tools that change no file, and inputs with no path', () => {
    expect(toolCallFileChanges(call('Bash', { command: 'sed -i s/a/b/ x' }))).toEqual([])
    expect(toolCallFileChanges(call('Read', { file_path: '/r/a.ts' }))).toEqual([])
    expect(toolCallFileChanges(call('Edit', { old_string: 'a', new_string: 'b' }))).toEqual([])
    expect(toolCallFileChanges(call('Edit', 'not json'))).toEqual([])
  })
})

describe('toolCallFileChanges — the bulk was withheld', () => {
  it('main\'s precomputed changes win over a stubbed input', () => {
    const record = {
      ...call('Write', { file_path: '/r/a.ts' }),
      inputWithheld: true,
      fileChanges: [{ path: '/r/a.ts', added: 40, removed: 0, counted: true, created: true, whole: true }],
    }
    expect(toolCallFileChanges(record)).toEqual(record.fileChanges)
  })

  it('a summarized input with nothing precomputed names the file without numbers', () => {
    const record = { ...call('Edit', { file_path: '/r/a.ts', old_string: 'short' }), inputWithheld: true }
    expect(toolCallFileChanges(record)).toEqual([{ path: '/r/a.ts', added: 0, removed: 0, counted: false, created: null }])
  })
})

describe('toolCallFileChanges — Copilot', () => {
  it('create is always a new file', () => {
    expect(toolCallFileChanges(call('create', { path: '/r/t.txt', file_text: 'ok\nyes' }))).toEqual([
      { path: '/r/t.txt', added: 2, removed: 0, counted: true, created: true, whole: true },
    ])
  })

  it('edit and str_replace diff old_str to new_str', () => {
    expect(toolCallFileChanges(call('str_replace', { path: '/r/a', old_str: 'a', new_str: 'b\nc' }))).toEqual([
      { path: '/r/a', added: 2, removed: 1, counted: true, created: false },
    ])
    expect(toolCallFileChanges(call('edit', { path: '/r/a', old_str: 'a', new_str: 'a' }))[0]).toMatchObject({ added: 0, removed: 0 })
  })

  it('str_replace_editor follows its command', () => {
    expect(toolCallFileChanges(call('str_replace_editor', { command: 'create', path: '/r/a', file_text: 'x' }))[0]).toMatchObject({ created: true, added: 1 })
    expect(toolCallFileChanges(call('str_replace_editor', { command: 'insert', path: '/r/a', new_str: 'x\ny' }))[0]).toMatchObject({ created: false, added: 2 })
    expect(toolCallFileChanges(call('str_replace_editor', { command: 'view', path: '/r/a' }))).toEqual([])
  })

  it('apply_patch counts its own + and - lines per file', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+one',
      '+two',
      '*** Update File: src/old.ts',
      '@@ function f',
      ' keep',
      '-gone',
      '+came',
      '+also',
      '*** Delete File: src/dead.ts',
      '*** End Patch',
    ].join('\n')
    expect(toolCallFileChanges(call('apply_patch', { input: patch }))).toEqual([
      { path: 'src/new.ts', added: 2, removed: 0, counted: true, created: true },
      { path: 'src/old.ts', added: 2, removed: 1, counted: true, created: false },
      { path: 'src/dead.ts', added: 0, removed: 0, counted: false, created: false, deleted: true },
    ])
  })

  it('a moved file is named by where it went', () => {
    expect(patchChanges('*** Update File: a.ts\n*** Move to: b.ts\n-x\n+y')).toEqual([
      { path: 'b.ts', added: 1, removed: 1, counted: true, created: false },
    ])
  })
})

describe('toolCallFileChanges — Codex', () => {
  it('a file_change names its files and whether each was added, with no line counts', () => {
    const item = {
      id: 'item_1',
      type: 'file_change',
      changes: [
        { path: '/r/note.txt', kind: 'add' },
        { path: '/r/old.txt', kind: 'update' },
        { path: '/r/gone.txt', kind: 'delete' },
      ],
      status: 'completed',
    }
    expect(toolCallFileChanges(call('Write', item))).toEqual([
      { path: '/r/note.txt', added: 0, removed: 0, counted: false, created: true },
      { path: '/r/old.txt', added: 0, removed: 0, counted: false, created: false },
      { path: '/r/gone.txt', added: 0, removed: 0, counted: false, created: false, deleted: true },
    ])
  })
})

describe('which calls count', () => {
  it('only a clean finish is a change', () => {
    expect(countsAsChange('success')).toBe(true)
    for (const status of ['error', 'denied', 'interrupted', 'running', 'pending'] as const) {
      expect(countsAsChange(status)).toBe(false)
    }
  })

  it('knows the file tools of every runtime, case-insensitively', () => {
    for (const name of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'create', 'str_replace_editor', 'apply_patch']) {
      expect(isFileChangeTool(name)).toBe(true)
    }
    expect(isFileChangeTool('Bash')).toBe(false)
    expect(isFileChangeTool('view')).toBe(false)
  })
})
