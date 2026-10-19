/**
 * WHAT WE TELL SOMEBODY WE COLLECT — generated from the allowlist, not written
 * beside it.
 *
 * A privacy notice maintained by hand drifts from the code on the first new
 * field, and the drift is invisible: the notice still reads well, it is simply
 * no longer true. Deriving the list from `telemetry-allowlist.ts` means the only
 * way to collect something new is to make it appear in what the user is shown.
 *
 * DOM-free so it can be tested, and so the wizard and the settings panel say the
 * same thing — two surfaces that describe one promise in two wordings is how one
 * of them ends up wrong.
 */

import { EVENT_FIELDS, INSTALL_FIELDS } from './telemetry-allowlist'

/** One line of the "what is sent" list. */
export interface DisclosureLine {
  label: string
  detail: string
}

/** Plain-English names for the fields, in the order a person reads them. */
const FIELD_WORDS: Record<string, string> = {
  installId: 'a random id for this installation',
  appVersion: 'which version of Flow you are running',
  platform: 'macOS or Windows',
  osVersion: 'your operating system version',
  arch: 'your processor type',
  locale: 'your language',
  timezone: 'your time zone',
  firstRunAt: 'when you first ran Flow',
  sessionId: 'a random id for this run of the app',
  event: 'which feature was used, from a fixed list',
  at: 'when it happened',
  count: 'how many',
  durationMs: 'how long it took',
  provider: 'which AI provider',
  model: 'which model',
  featureFlags: 'which settings were on',
  projectCount: 'how many projects you have open',
  threadCount: 'how many conversations you have',
  errorKind: 'which part of Flow failed, from a fixed list',
  identityId: 'who you are, once you sign in — and nothing until then',
}

/**
 * The plain-English word for a field, or the field itself when nobody wrote one.
 *
 * Returning the raw name rather than throwing is deliberate: a missing word is
 * a documentation bug, not a reason to break the settings panel. The test below
 * is what makes sure it never ships.
 */
export function wordFor(field: string): string {
  return FIELD_WORDS[field] ?? field
}

/** Exactly what leaves, said in words, derived from the contract. */
export function disclosureLines(): DisclosureLine[] {
  return [
    {
      label: 'About this installation',
      detail: INSTALL_FIELDS.map(wordFor).join(', '),
    },
    {
      label: 'About how you use it',
      detail: EVENT_FIELDS.map(wordFor).join(', '),
    },
  ]
}

/**
 * What NEVER leaves.
 *
 * Stated positively and specifically, because "we respect your privacy" is
 * what everyone says and tells a developer nothing. These are the things this
 * particular app could see, named, so the promise is checkable.
 */
export const NEVER_SENT: readonly string[] = [
  'anything you type into the chat',
  'anything an agent writes back',
  'the contents of your files',
  'the names of your files, folders, projects, branches or repositories',
  'your terminal output',
  'anything from pages you open in the browser',
  'your API keys, of any kind',
]

/** The question the first-run wizard asks. */
export const CONSENT_QUESTION = 'Share anonymous usage data?'

/**
 * The sentence under it.
 *
 * Says what it is FOR, because a person deciding wants to know what they are
 * giving it to — and says the app is unaffected, because the fear is that
 * declining costs them something.
 */
export const CONSENT_BODY =
  'It helps us see which features get used and which builds break, so Flow gets better. ' +
  'It never includes your code, your conversations or anything you type. ' +
  'Flow works exactly the same either way, and you can change your mind in Settings.'

/** Both answers, weighted the same — a decision, not a nudge. */
export const CONSENT_YES = 'Share usage data'
export const CONSENT_NO = "Don't share"
