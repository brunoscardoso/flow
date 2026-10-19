import { fileChatLabel, sendableSelection } from './editor-selection-chat'

describe('fileChatLabel (#462)', () => {
  it('uses the file base name', () => {
    expect(fileChatLabel('/Users/me/proj/src/app.ts')).toBe('app.ts')
    expect(fileChatLabel('README.md')).toBe('README.md')
    expect(fileChatLabel('a\\b\\c.tsx')).toBe('c.tsx') // windows separators
  })
  it('falls back to "File" for empty/missing paths', () => {
    expect(fileChatLabel(null)).toBe('File')
    expect(fileChatLabel(undefined)).toBe('File')
    expect(fileChatLabel('')).toBe('File')
    expect(fileChatLabel('/trailing/')).toBe('File')
  })
})

describe('sendableSelection', () => {
  it('trims and returns non-empty selections', () => {
    expect(sendableSelection('  const x = 1  ')).toBe('const x = 1')
  })
  it('returns null for empty/whitespace/missing selections', () => {
    expect(sendableSelection('')).toBeNull()
    expect(sendableSelection('   \n\t ')).toBeNull()
    expect(sendableSelection(null)).toBeNull()
    expect(sendableSelection(undefined)).toBeNull()
  })
})
