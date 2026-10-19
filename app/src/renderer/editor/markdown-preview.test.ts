import { isMarkdownPath, previewToggleLabel } from './markdown-preview'

describe('isMarkdownPath (#575)', () => {
  it('matches .md files', () => {
    expect(isMarkdownPath('/r/README.md')).toBe(true)
    expect(isMarkdownPath('/r/docs/plan.md')).toBe(true)
  })

  it('matches .markdown files', () => {
    expect(isMarkdownPath('/r/notes.markdown')).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isMarkdownPath('/r/README.MD')).toBe(true)
    expect(isMarkdownPath('/r/Notes.Markdown')).toBe(true)
  })

  it('rejects non-markdown files', () => {
    expect(isMarkdownPath('/r/index.ts')).toBe(false)
    expect(isMarkdownPath('/r/style.css')).toBe(false)
    expect(isMarkdownPath('/r/data.json')).toBe(false)
  })

  it('rejects paths that merely contain "md" but do not end in it', () => {
    expect(isMarkdownPath('/r/md/index.ts')).toBe(false)
    expect(isMarkdownPath('/r/readme.mdx')).toBe(false)
    expect(isMarkdownPath('/r/command.ts')).toBe(false)
  })

  it('rejects non-file tab ids (views)', () => {
    expect(isMarkdownPath('flow://blueprint')).toBe(false)
  })
})

describe('previewToggleLabel (#575)', () => {
  it('reads "Preview" when showing source', () => {
    expect(previewToggleLabel(false)).toBe('Preview')
  })

  it('reads "Source" when showing the rendered preview', () => {
    expect(previewToggleLabel(true)).toBe('Source')
  })
})
