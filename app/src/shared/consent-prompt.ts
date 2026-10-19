/**
 * WHEN TO ASK ABOUT TELEMETRY — not at first run.
 *
 * The question used to live in the first-run wizard, which is the worst moment
 * to ask it: somebody is three screens deep in getting started, has not seen
 * the app do anything yet, and is being asked to make a judgement about a thing
 * they have no feel for. The honest answer to "may we collect usage data" on
 * screen two is "I have no idea what you even do".
 *
 * So it is asked on the THIRD DAY THEY ACTUALLY USE FLOW (user, 2026-09-22).
 * By then the question is about something real.
 *
 * ── DAYS OF USE, NOT DAYS SINCE INSTALL ─────────────────────────────────────
 *
 * Somebody who installs Flow, opens it once and comes back a fortnight later
 * should be asked on their third real day, not on a Thursday they never opened
 * it. A calendar countdown from the install date fires while the app is closed,
 * which is both useless and slightly rude.
 *
 * ── DISMISSING IS NOT ANSWERING, AND NAGGING IS NOT ASKING ──────────────────
 *
 * Closing the prompt leaves consent unanswered, which means nothing is
 * collected — so a dismissal costs the person nothing and must not be read as a
 * no. But a prompt that returns every launch until it gets its way is how a
 * consent dialog becomes something people click through without reading, which
 * produces a "yes" worth nothing to anybody.
 *
 * Three asks, spaced by REAL USE: days 3, 7 and 14. After that the question
 * lives in Settings and Flow stops raising it.
 *
 * Pure and DOM-free: this decides, and something else draws.
 */

/**
 * The use-day counts a prompt may appear on.
 *
 * Spaced by days of use rather than by a clock, for the same reason the trigger
 * is: the gap should be "a few more times using it", not "a few more Tuesdays".
 */
export const ASK_ON_USE_DAYS: readonly number[] = [3, 7, 14]

/** What the app knows when it decides whether to raise the question. */
export interface ConsentPromptState {
  /** Three-valued: `null` is nobody having been asked, which is not a no. */
  consent: boolean | null
  /** Distinct calendar days this installation has been opened. */
  useDays: number
  /** How many times the prompt has been shown and dismissed. */
  timesAsked: number
}

/**
 * Should Flow raise the question now?
 *
 * Every branch is a reason NOT to ask, which is the right shape for this: the
 * default is silence, and asking is the exception that has to be earned.
 */
export function shouldAskForConsent(state: ConsentPromptState): boolean {
  // ALREADY ANSWERED — either way. Changing their mind is what Settings is for;
  // the app does not reopen a decision somebody has made.
  if (state.consent !== null) return false
  // Out of asks. The question is in Settings and Flow stops raising it.
  if (state.timesAsked >= ASK_ON_USE_DAYS.length) return false
  const threshold = ASK_ON_USE_DAYS[state.timesAsked]
  if (threshold === undefined) return false
  return state.useDays >= threshold
}

/**
 * The local calendar day, as a stable key.
 *
 * LOCAL, not UTC: "the third day you used it" is a human sentence about the
 * person's own days. A UTC key would roll over mid-evening for anyone west of
 * Greenwich and count one sitting as two.
 */
export function useDayKey(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The use-day count after an app start on `today`.
 *
 * Returns the same count when it is a day already counted, so several launches
 * in one afternoon are one day. `lastDay` null means this installation has
 * never been counted — its first start is day one.
 */
export function countUseDay(
  previous: { useDays: number; lastDay: string | null },
  today: string,
): { useDays: number; lastDay: string } {
  if (previous.lastDay === today) return { useDays: previous.useDays, lastDay: today }
  return { useDays: previous.useDays + 1, lastDay: today }
}
