import { revealRelForRow } from './git-reveal'

describe('revealRelForRow', () => {
  it('passes leaf file paths through unchanged', () => {
    expect(revealRelForRow('file', 'src/app.ts')).toBe('src/app.ts')
    expect(revealRelForRow('child', 'src/nested/x.ts')).toBe('src/nested/x.ts')
  })

  it('strips the trailing slash from a rolled-up directory row', () => {
    expect(revealRelForRow('dir', 'app/')).toBe('app')
    expect(revealRelForRow('dir', 'src/(protected)/')).toBe('src/(protected)')
  })

  it('collapses multiple trailing slashes on a directory row', () => {
    expect(revealRelForRow('dir', 'app///')).toBe('app')
  })

  it('leaves a directory path without a trailing slash unchanged', () => {
    expect(revealRelForRow('dir', 'app')).toBe('app')
  })
})
