/**
 * The privacy section says three different true things, never one hedged thing.
 */
import { privacyCopy } from './privacy-model'
import { disclosureLines, NEVER_SENT } from '../../shared/telemetry-disclosure'

describe('privacyCopy', () => {
  it('lists what is being sent ONLY when something is being sent', () => {
    expect(privacyCopy(true).sending.length).toBeGreaterThan(0)
    expect(privacyCopy(false).sending).toEqual([])
    expect(privacyCopy(null).sending).toEqual([])
  })

  it('distinguishes "you said no" from "nobody asked you"', () => {
    const declined = privacyCopy(false).status
    const unasked = privacyCopy(null).status
    expect(declined).not.toEqual(unasked)
    // Neither may claim a choice the person did not make.
    expect(unasked).toMatch(/not been asked/i)
    expect(declined).not.toMatch(/not been asked/i)
  })

  it('says nothing is leaving, in both of the states where nothing is', () => {
    for (const consent of [false, null] as const) {
      expect(privacyCopy(consent).status).toMatch(/not send|nothing/i)
    }
  })

  // THE SECTION SHOWS THE DERIVED LIST, not a paraphrase of it. That the list
  // is complete and free of raw identifiers is telemetry-disclosure's own
  // promise, pinned in its own suite; what is this module's job is carrying it
  // through untouched, so a new field reaches the panel with nobody's help.
  it('shows the derived disclosure itself, not a copy of it', () => {
    expect(privacyCopy(true).sending).toEqual(disclosureLines())
  })

  it('keeps the never-sent promise verbatim from the shared source', () => {
    for (const consent of [true, false, null] as const) {
      expect(privacyCopy(consent).never).toBe(NEVER_SENT)
    }
  })

  it('labels the switch by what it does, identically in every state', () => {
    const labels = new Set([true, false, null].map((c) => privacyCopy(c as boolean | null).toggleLabel))
    expect(labels.size).toBe(1)
  })
})
