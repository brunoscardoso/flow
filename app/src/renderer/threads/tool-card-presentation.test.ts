import {
  basename,
  changeSummary,
  classifyTool,
  computeLineDiff,
  filePathOf,
  type PresentableCall,
} from './tool-card-presentation'

const call = (toolName: string, input: Record<string, unknown> | null): PresentableCall => ({
  toolName,
  inputJson: input === null ? null : JSON.stringify(input),
})

const edit = (path: string, oldStr = 'a', newStr = 'b'): PresentableCall =>
  call('Edit', { file_path: path, old_string: oldStr, new_string: newStr })

describe('classifyTool', () => {
  it('maps edit tools, write, and everything else', () => {
    expect(classifyTool('Edit')).toBe('edit')
    expect(classifyTool('NotebookEdit')).toBe('edit')
    expect(classifyTool('Write')).toBe('write')
    expect(classifyTool('Read')).toBe('other')
    expect(classifyTool('Bash')).toBe('other')
  })
})

describe('changeSummary', () => {
  it('shows the first changed line for an edit, not the path', () => {
    expect(changeSummary(edit('/src/foo.ts', 'const a = 1', 'const a = 2'))).toBe('const a = 2')
  })

  it('falls back to a line-delta when there is no non-blank added line', () => {
    expect(changeSummary(edit('/src/foo.ts', 'gone' + String.fromCharCode(10) + 'removed', ''))).toBe(
      '+1 ' + String.fromCharCode(8722) + '2',
    )
  })

  it('summarizes a write by its added line count', () => {
    const content = 'one' + String.fromCharCode(10) + 'two' + String.fromCharCode(10) + 'three'
    expect(changeSummary(call('Write', { file_path: '/a', content }))).toBe('+3 lines')
  })

  it('is empty when the input is absent (a withheld edit falls back to the path)', () => {
    expect(changeSummary(call('Edit', null))).toBe('')
  })
})

describe('computeLineDiff', () => {
  it('trims the common prefix and suffix, leaving only the changed middle', () => {
    const NL = String.fromCharCode(10)
    const diff = computeLineDiff('a' + NL + 'OLD' + NL + 'c', 'a' + NL + 'NEW' + NL + 'c')
    expect(diff).toEqual({ removed: ['OLD'], added: ['NEW'], truncated: false })
  })

  it('reports truncation past the line bound and clips over-wide lines', () => {
    const NL = String.fromCharCode(10)
    const many = Array.from({ length: 10 }, (_, i) => 'line ' + i).join(NL)
    const diff = computeLineDiff('', many, { maxLines: 3, maxWidth: 4 })
    expect(diff.truncated).toBe(true)
    expect(diff.added).toHaveLength(3)
    expect(diff.added[0]).toBe('line' + String.fromCharCode(8230))
  })
})

describe('basename / filePathOf', () => {
  it('takes the last path segment across separators', () => {
    expect(basename('/src/a/foo.ts')).toBe('foo.ts')
    expect(basename('C:' + String.fromCharCode(92) + 'src' + String.fromCharCode(92) + 'bar.ts')).toBe('bar.ts')
    expect(basename('plain')).toBe('plain')
  })

  it('reads the file path off an edit/write input', () => {
    expect(filePathOf(edit('/src/foo.ts'))).toBe('/src/foo.ts')
    expect(filePathOf(call('Bash', { command: 'ls' }))).toBeNull()
  })
})
