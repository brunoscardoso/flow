import { shouldClearSearchOnThreadCreate, shouldClearSearchOnThreadRename } from './search-filter'

describe('shouldClearSearchOnThreadCreate (#386)', () => {
  it('clears the filter when a non-empty search is active', () => {
    expect(shouldClearSearchOnThreadCreate('qqzz-nomatch')).toBe(true)
    expect(shouldClearSearchOnThreadCreate('auth')).toBe(true)
  })

  it('does nothing when no search is active', () => {
    expect(shouldClearSearchOnThreadCreate('')).toBe(false)
    expect(shouldClearSearchOnThreadCreate('   ')).toBe(false) // whitespace-only == no filter
  })
})

describe('shouldClearSearchOnThreadRename (#977)', () => {
  it('clears when the new title no longer matches the live query', () => {
    expect(shouldClearSearchOnThreadRename('Alpha', 'Quarterly summary')).toBe(true)
  })

  it('keeps the filter when the new title still matches (case-insensitive)', () => {
    expect(shouldClearSearchOnThreadRename('Alpha', 'Alpha revised')).toBe(false)
    expect(shouldClearSearchOnThreadRename('alpha', 'ALPHA revised')).toBe(false)
    expect(shouldClearSearchOnThreadRename('  Alpha ', 'my alpha notes')).toBe(false)
  })

  it('does nothing when no search is active', () => {
    expect(shouldClearSearchOnThreadRename('', 'Anything')).toBe(false)
    expect(shouldClearSearchOnThreadRename('   ', 'Anything')).toBe(false)
  })
})

describe('the rename guard mirrors what the store actually matches (#1365)', () => {
  // The guard's own comment claimed it mirrored the store. It did not: the
  // store matched by FTS token PREFIX, so a substring hit inside a token was
  // invisible to it — the guard kept the filter and the store dropped the row.
  // #1364 made the store union a substring scan, so these now agree.
  it('keeps the filter for a substring hit INSIDE a token', () => {
    // `store` does not prefix-match the token `user_store`; it does substring-
    // match it, and since #1364 so does the store.
    expect(shouldClearSearchOnThreadRename('store', 'user_store migration')).toBe(false)
  })

  it('keeps the filter for a mid-token hit in camelCase', () => {
    expect(shouldClearSearchOnThreadRename('Store', 'userStoreMigration')).toBe(false)
  })

  it('still clears when the new title genuinely cannot match', () => {
    expect(shouldClearSearchOnThreadRename('store', 'unrelated title')).toBe(true)
  })

  it('is case-insensitive in both directions', () => {
    expect(shouldClearSearchOnThreadRename('STORE', 'user_store migration')).toBe(false)
    expect(shouldClearSearchOnThreadRename('store', 'USER_STORE MIGRATION')).toBe(false)
  })
})
