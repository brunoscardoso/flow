import { DEFAULT_FILE_COLOR, fileIconColor } from './file-icon-color'

describe('fileIconColor', () => {
  it('tints by extension (case-insensitive)', () => {
    expect(fileIconColor('app.ts')).toBe('#519aba')
    expect(fileIconColor('Main.TS')).toBe('#519aba')
    expect(fileIconColor('script.py')).toBe('#519aba')
    expect(fileIconColor('data.json')).toBe('#cbcb41')
    expect(fileIconColor('notes.md')).toBe('#519aba')
    expect(fileIconColor('index.js')).toBe('#cbcb41')
  })

  it('matches exact filenames before extension', () => {
    expect(fileIconColor('package.json')).toBe('#8dc149') // not the generic json yellow
    expect(fileIconColor('.gitignore')).toBe('#e37933')
    expect(fileIconColor('Dockerfile')).toBe('#519aba')
  })

  it('falls back to the default color for unknown/extensionless/dotfiles', () => {
    expect(fileIconColor('mystery.xyz')).toBe(DEFAULT_FILE_COLOR)
    expect(fileIconColor('LICENSE_NOTES')).toBe(DEFAULT_FILE_COLOR)
    expect(fileIconColor('.bashrc')).toBe(DEFAULT_FILE_COLOR) // leading dot, no ext
  })
})
