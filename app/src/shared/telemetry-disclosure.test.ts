import { ALLOWED_FIELDS } from './telemetry-allowlist'
import {
  wordFor,
  CONSENT_BODY,
  CONSENT_NO,
  CONSENT_YES,
  NEVER_SENT,
  disclosureLines,
} from './telemetry-disclosure'

describe('what we tell people we collect', () => {
  it('describes EVERY field on the allowlist, in words', () => {
    // The guard against a notice that drifts: adding a field to the contract
    // without adding a word for it fails here, so the only way to collect
    // something new is to make it appear in what the user is shown.
    //
    // Asked of the MAPPING, not of the rendered sentence — "at" is a substring
    // of "installation" and the copy legitimately contains the words "provider"
    // and "model", so scanning the prose reports gaps that are not there.
    const undescribed = ALLOWED_FIELDS.filter((field) => wordFor(field) === field)
    expect(undescribed).toEqual([])
  })

  it('names what never leaves, specifically', () => {
    // "We respect your privacy" is what everyone says and tells a developer
    // nothing. These are the things THIS app could see, named.
    const text = NEVER_SENT.join(' ')
    for (const thing of ['type into the chat', 'contents of your files', 'terminal output', 'API keys']) {
      expect(text).toContain(thing)
    }
  })

  it('offers both answers with equal weight', () => {
    // A decision, not a nudge: neither option is phrased as the safe one.
    expect(CONSENT_YES.length).toBeLessThan(30)
    expect(CONSENT_NO.length).toBeLessThan(30)
    expect(CONSENT_NO.toLowerCase()).not.toContain('not recommended')
  })

  it('says the app is unaffected, because that is the actual fear', () => {
    expect(CONSENT_BODY).toContain('exactly the same either way')
    expect(CONSENT_BODY).toContain('change your mind')
  })

  it('does not put a path, a command or a config key in front of a person', () => {
    // forbidden-pattern #12.
    const copy = [CONSENT_BODY, ...NEVER_SENT, ...disclosureLines().map((l) => l.detail)].join(' ')
    expect(copy).not.toMatch(/\bnpm |planflow-ai|\.flowconfig|src\//)
  })
})
