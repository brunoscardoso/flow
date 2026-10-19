import {
  ASK_ON_USE_DAYS,
  countUseDay,
  shouldAskForConsent,
  useDayKey,
} from './consent-prompt'

const unasked = { consent: null, useDays: 0, timesAsked: 0 }

describe('when to raise the question', () => {
  it('stays quiet for the first two days of use', () => {
    expect(shouldAskForConsent({ ...unasked, useDays: 0 })).toBe(false)
    expect(shouldAskForConsent({ ...unasked, useDays: 1 })).toBe(false)
    expect(shouldAskForConsent({ ...unasked, useDays: 2 })).toBe(false)
  })

  it('asks on the third day they actually use it', () => {
    expect(shouldAskForConsent({ ...unasked, useDays: 3 })).toBe(true)
  })

  // ALREADY ANSWERED — either way. Changing their mind is what Settings is for;
  // the app does not reopen a decision somebody has made.
  it.each([true, false])('never asks again once they answered %p', (consent) => {
    expect(shouldAskForConsent({ consent, useDays: 99, timesAsked: 0 })).toBe(false)
  })

  // Dismissing leaves consent unanswered, so nothing is collected — a dismissal
  // costs them nothing and must not be read as a no.
  it('asks again on a later day of use, not on the next launch', () => {
    // Dismissed on day 3; still day 3, so the prompt does not return.
    expect(shouldAskForConsent({ ...unasked, useDays: 3, timesAsked: 1 })).toBe(false)
    expect(shouldAskForConsent({ ...unasked, useDays: 6, timesAsked: 1 })).toBe(false)
    expect(shouldAskForConsent({ ...unasked, useDays: 7, timesAsked: 1 })).toBe(true)
  })

  it('asks a third time, and then never again', () => {
    expect(shouldAskForConsent({ ...unasked, useDays: 14, timesAsked: 2 })).toBe(true)
    expect(shouldAskForConsent({ ...unasked, useDays: 14, timesAsked: 3 })).toBe(false)
    // A prompt that returned for ever is how a consent dialog becomes something
    // people click through without reading.
    expect(shouldAskForConsent({ ...unasked, useDays: 10_000, timesAsked: 3 })).toBe(false)
  })

  it('asks at most as many times as there are thresholds', () => {
    let asks = 0
    let timesAsked = 0
    for (let day = 1; day <= 400; day += 1) {
      if (shouldAskForConsent({ consent: null, useDays: day, timesAsked })) {
        asks += 1
        timesAsked += 1
      }
    }
    expect(asks).toBe(ASK_ON_USE_DAYS.length)
  })

  it('catches up rather than skipping when somebody returns after a long gap', () => {
    // Installed, used twice, vanished for a year, came back. They are owed the
    // question — not silence because the moment passed.
    expect(shouldAskForConsent({ ...unasked, useDays: 40, timesAsked: 0 })).toBe(true)
  })
})

describe('counting a day of use', () => {
  it('counts the first start as day one', () => {
    expect(countUseDay({ useDays: 0, lastDay: null }, '2026-09-22')).toEqual({
      useDays: 1,
      lastDay: '2026-09-22',
    })
  })

  it('counts several launches in one afternoon as one day', () => {
    let state: { useDays: number; lastDay: string | null } = { useDays: 0, lastDay: null }
    for (let i = 0; i < 5; i += 1) state = countUseDay(state, '2026-09-22')
    expect(state.useDays).toBe(1)
  })

  it('counts a new day as a new day', () => {
    const first = countUseDay({ useDays: 0, lastDay: null }, '2026-09-22')
    const second = countUseDay(first, '2026-09-23')
    expect(second).toEqual({ useDays: 2, lastDay: '2026-09-23' })
  })

  // DAYS OF USE, NOT DAYS SINCE INSTALL. Somebody who installs Flow and returns
  // a fortnight later is on their second day of use, not their fifteenth.
  it('does not advance for days the app was never opened', () => {
    const day1 = countUseDay({ useDays: 0, lastDay: null }, '2026-09-01')
    const later = countUseDay(day1, '2026-09-15')
    expect(later.useDays).toBe(2)
  })
})

describe('the day key', () => {
  // LOCAL, not UTC: a UTC key rolls over mid-evening for anyone west of
  // Greenwich and counts one sitting as two.
  it('is the local calendar date', () => {
    const at = new Date(2026, 8, 22, 23, 30)
    expect(useDayKey(at)).toBe('2026-09-22')
  })

  it('pads so keys sort and compare as strings', () => {
    expect(useDayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('is the same key for two moments on one local day', () => {
    expect(useDayKey(new Date(2026, 8, 22, 0, 1))).toBe(useDayKey(new Date(2026, 8, 22, 23, 59)))
  })
})
