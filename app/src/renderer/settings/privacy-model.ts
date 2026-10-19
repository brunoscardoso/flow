/**
 * WHAT THE PRIVACY SECTION SAYS, for each of the three states it can be in.
 *
 * DOM-free, because the sentence is the part worth pinning and this app's jest
 * cannot import a module that touches `document`. The section itself is a
 * heading, a switch and this text.
 *
 * A SWITCH WHOSE CONSEQUENCES ARE INVISIBLE IS A SWITCH NOBODY TRUSTS. The plan
 * asked for a section that shows WHAT IS BEING SENT rather than a toggle with a
 * policy link, and that is the difference this module exists to carry: the
 *status line says what is happening right now, and the list below it — derived
 * from the allowlist — says exactly what that means.
 */

import { disclosureLines, NEVER_SENT, type DisclosureLine } from '../../shared/telemetry-disclosure'

/** Consent as the app knows it: yes, no, or never asked. */
export type ConsentState = boolean | null

export interface PrivacyCopy {
  /** The switch's label — what turning it on does, not what it is called. */
  toggleLabel: string
  /** What is true right now, in one sentence. */
  status: string
  /** Shown only while something is actually being sent. */
  sending: DisclosureLine[]
  /** Always shown: the promise is worth more than the permission. */
  never: readonly string[]
}

export function privacyCopy(consent: ConsentState): PrivacyCopy {
  const toggleLabel = 'Share anonymous usage data'
  const never = NEVER_SENT

  if (consent === true) {
    return {
      toggleLabel,
      status: 'Flow is sharing the usage data below. Turn this off and it stops immediately.',
      // THE LIST ONLY APPEARS WHEN IT IS TRUE. Showing "here is what we send"
      // beside a switch that is off describes a thing that is not happening,
      // and a reader has to work out which half applies to them.
      sending: disclosureLines(),
      never,
    }
  }
  if (consent === false) {
    return {
      toggleLabel,
      status: 'Flow is not sending anything. Nothing about this installation or how you use it leaves your machine.',
      sending: [],
      never,
    }
  }
  // NEVER ASKED is its own sentence, not "off". The wizard may not have been
  // reached — saying "you turned this off" to somebody who was never asked is
  // the app telling them something untrue about their own choices.
  return {
    toggleLabel,
    status: 'You have not been asked yet, so Flow is not sending anything.',
    sending: [],
    never,
  }
}
