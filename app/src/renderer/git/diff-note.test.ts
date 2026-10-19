import { diffNote } from './diff-note'

const base = { filePath: 'script.sh', beforeContent: 'a\n', afterContent: 'a\n' }

describe('diffNote (#1185)', () => {
  it('prefers main’s mode-change note — the case the panes cannot show', () => {
    expect(diffNote({ ...base, note: 'Mode changed: 100644 → 100755 (no content changes)' })).toBe(
      'Mode changed: 100644 → 100755 (no content changes)',
    )
  })

  it('says an empty file is empty, instead of showing two blank panes', () => {
    expect(diffNote({ filePath: 'empty.txt', beforeContent: '', afterContent: '' })).toBe(
      'This file is empty.',
    )
  })

  it('says SOMETHING when the sides match and main offered no reason', () => {
    // Two identical panes with no explanation read exactly like a failed load.
    expect(diffNote(base)).toBe('No content changes.')
  })

  it('stays silent for an ordinary diff', () => {
    expect(diffNote({ ...base, afterContent: 'b\n' })).toBeNull()
  })

  it('stays silent for a binary file — it has its own notice', () => {
    expect(diffNote({ filePath: 'logo.png', beforeContent: '', afterContent: '', binary: true }))
      .toBeNull()
  })
})
