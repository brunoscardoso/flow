// The ONE autopilot resolution — the key wins, the marker is the fallback.
//
// This used to be two lines inline in the observer. It moved out when the chain
// driver needed the same answer, because two copies of a two-branch rule are two
// copies that can disagree (allowed-pattern #14).

import { autopilotEnabledIn } from './autopilot'

describe('autopilotEnabledIn', () => {
  it('the key wins whenever it is present — including when it says off', () => {
    expect(autopilotEnabledIn({ autopilot: 'true' }, false)).toBe(true)
    // A project that switched it off must not have a stale marker file switch
    // it back on.
    expect(autopilotEnabledIn({ autopilot: 'false' }, true)).toBe(false)
  })

  it('only the literal true is on — a typo is not a yes', () => {
    for (const value of ['yes', 'True', '1', '', 'on']) {
      expect(autopilotEnabledIn({ autopilot: value }, false)).toBe(false)
    }
  })

  it('tolerates the whitespace a hand-edited file leaves behind', () => {
    expect(autopilotEnabledIn({ autopilot: ' true ' }, false)).toBe(true)
  })

  it('falls back to the marker only for a project older than the key', () => {
    expect(autopilotEnabledIn({}, true)).toBe(true)
    expect(autopilotEnabledIn({}, false)).toBe(false)
  })
})
