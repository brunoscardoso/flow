// Pure drift-origin classifier tests (#drift phase 2) — no fs/git/Electron, so
// these run under plain `npx jest` (node env, ts-jest CJS).

import {
  classifyDriftEntries,
  classifyOrigin,
  type DriftEntryInput,
} from './drift-classify'

describe('classifyOrigin precedence', () => {
  it('an in-play module is always agent — overriding dirtiness and authorship', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: true,
        isDirty: true,
        committedAuthorEmail: 'someone@else.com',
        currentUserEmail: 'me@here.com',
      }),
    ).toBe('agent')
  })

  it('an uncommitted (dirty) edit that is not in play is yours', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: true,
        committedAuthorEmail: 'someone@else.com',
        currentUserEmail: 'me@here.com',
      }),
    ).toBe('yours')
  })

  it('a committed change by a different author is external', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: false,
        committedAuthorEmail: 'someone@else.com',
        currentUserEmail: 'me@here.com',
      }),
    ).toBe('external')
  })

  it('your own committed change is yours', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: false,
        committedAuthorEmail: 'me@here.com',
        currentUserEmail: 'me@here.com',
      }),
    ).toBe('yours')
  })

  it('compares emails case-insensitively and ignores surrounding whitespace', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: false,
        committedAuthorEmail: '  ME@Here.com ',
        currentUserEmail: 'me@here.com',
      }),
    ).toBe('yours')
  })
})

describe('classifyOrigin identity-unavailable fallback', () => {
  it('treats a committed change as external when the current user is unknown', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: false,
        committedAuthorEmail: 'someone@else.com',
        currentUserEmail: undefined,
      }),
    ).toBe('external')
  })

  it('an empty current-user email is treated the same as unavailable (external)', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: false,
        committedAuthorEmail: 'me@here.com',
        currentUserEmail: '',
      }),
    ).toBe('external')
  })

  it('a dirty file with no identity is still yours (dirty gate wins first)', () => {
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: true,
        currentUserEmail: undefined,
      }),
    ).toBe('yours')
  })

  it('a committed change with a known user but unknown author is yours', () => {
    // No committed author email to compare — cannot prove it was someone else,
    // and identity IS known, so it stays attributed to you.
    expect(
      classifyOrigin({
        path: 'src/a.ts',
        inPlay: false,
        isDirty: false,
        committedAuthorEmail: undefined,
        currentUserEmail: 'me@here.com',
      }),
    ).toBe('yours')
  })
})

describe('classifyDriftEntries', () => {
  it('maps a list against one shared identity context', () => {
    const entries: DriftEntryInput[] = [
      { path: 'a.ts', inPlay: true, isDirty: false },
      { path: 'b.ts', inPlay: false, isDirty: true },
      { path: 'c.ts', inPlay: false, isDirty: false, committedAuthorEmail: 'other@x.com' },
      { path: 'd.ts', inPlay: false, isDirty: false, committedAuthorEmail: 'me@here.com' },
    ]
    expect(classifyDriftEntries(entries, { currentUserEmail: 'me@here.com' })).toEqual([
      { path: 'a.ts', origin: 'agent' },
      { path: 'b.ts', origin: 'yours' },
      { path: 'c.ts', origin: 'external' },
      { path: 'd.ts', origin: 'yours' },
    ])
  })

  it('falls back to external for committed files when identity is absent', () => {
    const entries: DriftEntryInput[] = [
      { path: 'a.ts', inPlay: false, isDirty: false, committedAuthorEmail: 'me@here.com' },
      { path: 'b.ts', inPlay: false, isDirty: true },
    ]
    expect(classifyDriftEntries(entries, {})).toEqual([
      { path: 'a.ts', origin: 'external' },
      { path: 'b.ts', origin: 'yours' },
    ])
  })

  it('returns an empty array for no entries', () => {
    expect(classifyDriftEntries([], { currentUserEmail: 'me@here.com' })).toEqual([])
  })
})
