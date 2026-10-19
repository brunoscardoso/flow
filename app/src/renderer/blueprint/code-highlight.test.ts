import { languageForPath } from './code-highlight'

describe('languageForPath', () => {
  it('reads the extension', () => {
    expect(languageForPath('src/app/api/route.ts')).toBe('typescript')
    expect(languageForPath('src/components/Thing.tsx')).toBe('typescript')
    expect(languageForPath('scripts/run.mjs')).toBe('javascript')
    expect(languageForPath('package.json')).toBe('json')
    expect(languageForPath('flow/brain/index.md')).toBe('markdown')
  })

  it('is case-insensitive about it', () => {
    expect(languageForPath('A/B/Main.TS')).toBe('typescript')
  })

  it('answers plaintext for anything it does not know', () => {
    // Colouring nothing lies about nothing. Guessing from CONTENT is how a
    // JSON blob gets highlighted as JavaScript and the reader is told, in
    // colour, something the file never claimed.
    expect(languageForPath('some/thing.wat')).toBe('plaintext')
    expect(languageForPath('LICENSE')).toBe('plaintext')
  })

  it('treats a dotfile as plaintext — its name is not a language', () => {
    expect(languageForPath('.eslintrc')).toBe('plaintext')
    expect(languageForPath('app/.gitignore')).toBe('plaintext')
  })

  it('takes the extension from the file, never from a directory', () => {
    expect(languageForPath('src/thing.ts/inner')).toBe('plaintext')
  })
})
