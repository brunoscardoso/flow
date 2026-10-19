// Tests for the shared learning ignore-list matcher (#learn-ignore) — the ONE
// definition of "is this module scaffolding?" used by the orchestrator, the
// staleness triggers, and the learning panel's counts.

import {
  addIgnorePattern,
  ignoreSource,
  isIgnoredModule,
  parseLearnIgnore,
  removeIgnorePattern,
} from './learn-ignore'

describe('parseLearnIgnore', () => {
  it('returns [] for an absent value', () => {
    expect(parseLearnIgnore(undefined)).toEqual([])
  })

  it('returns [] for an empty/whitespace value', () => {
    expect(parseLearnIgnore('')).toEqual([])
    expect(parseLearnIgnore('  ,  , ')).toEqual([])
  })

  it('splits on commas and trims each pattern', () => {
    expect(parseLearnIgnore('vendor, generated/* ,third-party')).toEqual([
      'vendor',
      'generated/*',
      'third-party',
    ])
  })
})

describe('isIgnoredModule — built-in segment defaults', () => {
  it('ignores a module whose ANY posix segment is a default segment', () => {
    expect(isIgnoredModule('__mocks__')).toBe(true)
    expect(isIgnoredModule('__mocks__/@apollo')).toBe(true)
    expect(isIgnoredModule('e2e/tests/admin')).toBe(true)
    expect(isIgnoredModule('src/__tests__')).toBe(true)
    expect(isIgnoredModule('packages/app/fixtures/data')).toBe(true)
  })

  it('matches segments case-insensitively', () => {
    expect(isIgnoredModule('E2E')).toBe(true)
    expect(isIgnoredModule('src/__Mocks__')).toBe(true)
  })

  it('does NOT ignore ordinary source modules', () => {
    expect(isIgnoredModule('src')).toBe(false)
    expect(isIgnoredModule('src/components')).toBe(false)
    expect(isIgnoredModule('lib')).toBe(false)
  })

  it('matches whole segments only — `src/test-utils` is NOT ignored', () => {
    expect(isIgnoredModule('src/test-utils')).toBe(false)
    expect(isIgnoredModule('contest')).toBe(false)
    expect(isIgnoredModule('src/testing-library')).toBe(false)
  })

  it('normalizes windows separators and trailing slashes', () => {
    expect(isIgnoredModule('src\\__tests__')).toBe(true)
    expect(isIgnoredModule('e2e/')).toBe(true)
  })

  it('never ignores an empty path', () => {
    expect(isIgnoredModule('')).toBe(false)
  })
})

describe('isIgnoredModule — dot-dir defaults', () => {
  it('ignores any module whose path SEGMENT starts with a dot', () => {
    expect(isIgnoredModule('.cursor')).toBe(true)
    expect(isIgnoredModule('.github')).toBe(true)
    expect(isIgnoredModule('.vscode')).toBe(true)
    expect(isIgnoredModule('.github/workflows')).toBe(true)
    expect(isIgnoredModule('src/.hidden')).toBe(true)
  })

  it('does NOT ignore segments that merely CONTAIN a dot', () => {
    expect(isIgnoredModule('src/v1.2')).toBe(false)
    expect(isIgnoredModule('my.pkg')).toBe(false)
  })

  it('extras cannot un-ignore a dot-dir (add-only extras)', () => {
    expect(isIgnoredModule('.cursor', ['.cursor'])).toBe(true)
    expect(isIgnoredModule('.github', ['src'])).toBe(true)
  })
})

describe('isIgnoredModule — extra patterns', () => {
  it('matches an exact extra pattern', () => {
    expect(isIgnoredModule('vendor', ['vendor'])).toBe(true)
  })

  it('matches paths UNDER a plain extra pattern (prefix rule)', () => {
    expect(isIgnoredModule('vendor/sdk', ['vendor'])).toBe(true)
    expect(isIgnoredModule('vendored', ['vendor'])).toBe(false) // not a segment boundary
  })

  it('matches extra patterns case-insensitively', () => {
    expect(isIgnoredModule('Vendor/SDK', ['vendor'])).toBe(true)
    expect(isIgnoredModule('vendor', ['VENDOR'])).toBe(true)
  })

  it('treats a trailing /* as under-the-prefix only', () => {
    expect(isIgnoredModule('generated/api', ['generated/*'])).toBe(true)
    expect(isIgnoredModule('generated', ['generated/*'])).toBe(false)
  })

  it('skips empty extra patterns and leaves other modules alone', () => {
    expect(isIgnoredModule('src', ['', 'vendor'])).toBe(false)
    expect(isIgnoredModule('src', ['vendor'])).toBe(false)
  })
})

describe('ignoreSource (#learn-ignore UI)', () => {
  it("returns 'default' when a built-in segment or dot-dir causes the ignore", () => {
    expect(ignoreSource('__mocks__')).toBe('default')
    expect(ignoreSource('src/__tests__', [])).toBe('default')
    expect(ignoreSource('.cursor', [])).toBe('default')
    expect(ignoreSource('e2e/admin', ['vendor'])).toBe('default')
  })

  it("returns 'extra' ONLY when the extras (not defaults) cause the ignore", () => {
    expect(ignoreSource('vendor', ['vendor'])).toBe('extra')
    expect(ignoreSource('vendor/sdk', ['vendor'])).toBe('extra')
    expect(ignoreSource('generated/api', ['generated/*'])).toBe('extra')
  })

  it("prefers 'default' when a module is both default- and extra-ignored", () => {
    // removing the extra would NOT un-ignore it — the action must not lie
    expect(ignoreSource('__mocks__', ['__mocks__'])).toBe('default')
  })

  it('returns null when not ignored at all', () => {
    expect(ignoreSource('src', [])).toBeNull()
    expect(ignoreSource('src', ['vendor'])).toBeNull()
    expect(ignoreSource('', ['vendor'])).toBeNull()
  })
})

describe('addIgnorePattern', () => {
  it('appends the module and never mutates the input', () => {
    const extras = ['vendor']
    expect(addIgnorePattern(extras, 'src/lib')).toEqual(['vendor', 'src/lib'])
    expect(extras).toEqual(['vendor'])
  })

  it('dedups by MATCH — an already-covered module is not re-added', () => {
    expect(addIgnorePattern(['src/lib'], 'src/lib')).toEqual(['src/lib'])
    expect(addIgnorePattern(['vendor'], 'vendor/sdk')).toEqual(['vendor'])
    expect(addIgnorePattern(['generated/*'], 'generated/api')).toEqual(['generated/*'])
    expect(addIgnorePattern(['SRC/LIB'], 'src/lib')).toEqual(['SRC/LIB'])
  })

  it('trims the module and ignores an empty one', () => {
    expect(addIgnorePattern([], ' src/lib ')).toEqual(['src/lib'])
    expect(addIgnorePattern(['vendor'], '  ')).toEqual(['vendor'])
  })
})

describe('removeIgnorePattern', () => {
  it('removes the exact entry and never mutates the input', () => {
    const extras = ['vendor', 'src/lib']
    expect(removeIgnorePattern(extras, 'src/lib')).toEqual(['vendor'])
    expect(extras).toEqual(['vendor', 'src/lib'])
  })

  it('removes EVERY pattern matching the module (prefix + /*), so Unignore actually unignores', () => {
    expect(removeIgnorePattern(['vendor', 'other'], 'vendor/sdk')).toEqual(['other'])
    expect(removeIgnorePattern(['generated/*', 'vendor'], 'generated/api')).toEqual(['vendor'])
    expect(ignoreSource('vendor/sdk', removeIgnorePattern(['vendor'], 'vendor/sdk'))).toBeNull()
  })

  it('matches case-insensitively and leaves unrelated patterns alone', () => {
    expect(removeIgnorePattern(['VENDOR', 'src'], 'vendor')).toEqual(['src'])
    expect(removeIgnorePattern(['vendor'], 'src')).toEqual(['vendor'])
    expect(removeIgnorePattern(['vendor'], '')).toEqual(['vendor'])
  })
})

describe("Flow's own directory is not the project", () => {
  it('ignores flow/ and everything under it', () => {
    // Found in a real queue: `flow/resources` was the module being learned
    // while 356 of the user's own modules waited behind it. That directory
    // holds plan-flow's plans, discovery docs, brain and skill resources —
    // reading them teaches an agent about plan-flow.
    expect(isIgnoredModule('flow')).toBe(true)
    expect(isIgnoredModule('flow/resources')).toBe(true)
    expect(isIgnoredModule('flow/brain/features')).toBe(true)
  })

  it('does not swallow a source directory that merely contains the word', () => {
    // Per-segment matching, as everywhere else in this matcher.
    expect(isIgnoredModule('src/flowchart')).toBe(false)
    expect(isIgnoredModule('src/workflow')).toBe(false)
    expect(isIgnoredModule('packages/flow-engine')).toBe(false)
  })
})
