import type { FileContent, GitDiff } from '../../shared/ipc-contract'
import {
  PEEK_BINARY_NOTICE,
  PEEK_MAX_DIFF_BYTES,
  PEEK_NO_ROOT_NOTICE,
  PEEK_READ_ERROR_NOTICE,
  PEEK_TOO_LARGE_NOTICE,
  decidePeekDiffRender,
  decidePeekRender,
  escapeHtml,
  peekModelUri,
} from './peek-render'

function file(overrides: Partial<FileContent>): FileContent {
  return { relPath: 'src/a.ts', content: '', binary: false, ...overrides }
}

describe('decidePeekRender', () => {
  it('shows the no-root notice when there is no active project', () => {
    expect(decidePeekRender({ ok: true, file: file({ content: 'x' }) }, false)).toEqual({
      kind: 'notice',
      message: PEEK_NO_ROOT_NOTICE,
    })
  })

  it('shows the read-error notice when the read failed', () => {
    expect(decidePeekRender({ ok: false }, true)).toEqual({
      kind: 'notice',
      message: PEEK_READ_ERROR_NOTICE,
    })
  })

  it('shows the too-large notice ahead of binary (both flags set)', () => {
    const result = { ok: true as const, file: file({ binary: true, tooLarge: true }) }
    expect(decidePeekRender(result, true)).toEqual({
      kind: 'notice',
      message: PEEK_TOO_LARGE_NOTICE,
    })
  })

  it('shows the binary notice for a binary file', () => {
    const result = { ok: true as const, file: file({ binary: true }) }
    expect(decidePeekRender(result, true)).toEqual({
      kind: 'notice',
      message: PEEK_BINARY_NOTICE,
    })
  })

  it('renders the editor with content for a normal text file', () => {
    const result = { ok: true as const, file: file({ content: 'const a = 1\n' }) }
    expect(decidePeekRender(result, true)).toEqual({ kind: 'editor', content: 'const a = 1\n' })
  })
})

describe('decidePeekDiffRender', () => {
  function diff(overrides: Partial<GitDiff>): GitDiff {
    return { filePath: 'src/a.ts', beforeContent: '', afterContent: '', ...overrides }
  }

  it('renders the diff for a normal text diff', () => {
    const result = decidePeekDiffRender(diff({ beforeContent: 'a\n', afterContent: 'b\n' }), true)
    expect(result).toEqual({ kind: 'diff' })
  })

  it('shows the no-root notice when there is no active project', () => {
    expect(decidePeekDiffRender(diff({ afterContent: 'x' }), false)).toEqual({
      kind: 'notice',
      message: PEEK_NO_ROOT_NOTICE,
    })
  })

  it('shows the binary notice for a binary diff', () => {
    expect(decidePeekDiffRender(diff({ binary: true }), true)).toEqual({
      kind: 'notice',
      message: PEEK_BINARY_NOTICE,
    })
  })

  it('shows the too-large notice when combined content exceeds the limit', () => {
    const big = 'x'.repeat(PEEK_MAX_DIFF_BYTES + 1)
    expect(decidePeekDiffRender(diff({ afterContent: big }), true)).toEqual({
      kind: 'notice',
      message: PEEK_TOO_LARGE_NOTICE,
    })
  })
})

describe('escapeHtml', () => {
  it('escapes ampersands and angle brackets in order', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('escapes a tag-like fragment so it renders as text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })
})

describe('peekModelUri', () => {
  it('preserves the extension for language inference', () => {
    expect(peekModelUri('src/app/main.ts')).toBe('peek:///src/app/main.ts')
  })

  it('collapses leading slashes so the scheme host stays empty', () => {
    expect(peekModelUri('/deep/nested/file.json')).toBe('peek:///deep/nested/file.json')
  })
})
