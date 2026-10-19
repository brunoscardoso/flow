import { resolveAssignRevert } from './account-assign'

describe('resolveAssignRevert (#226)', () => {
  it('reverts to the previous binding when the select still shows the failed value', () => {
    // User picked 'acct-b'; assign('acct-b') failed; select still shows 'acct-b'.
    expect(resolveAssignRevert('acct-b', 'acct-b', 'acct-a')).toEqual({
      revert: true,
      value: 'acct-a',
    })
  })

  it('reverts to the "use default" empty value too', () => {
    expect(resolveAssignRevert('acct-b', 'acct-b', '')).toEqual({ revert: true, value: '' })
  })

  it('does NOT clobber a newer selection made while the failed assign was in flight', () => {
    // User picked 'acct-b' (failed), then picked 'acct-c' before B's rejection
    // landed — the stale failure must leave 'acct-c' alone.
    expect(resolveAssignRevert('acct-c', 'acct-b', 'acct-a')).toEqual({
      revert: false,
      value: 'acct-c',
    })
  })
})
