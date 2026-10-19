// The subject, minted from whatever a person typed — and always valid.
//
// SANITIZED, NEVER REFUSED (allowed-pattern #22). The aim is a sentence somebody
// wrote at a chat box, or a ticket's own free text, so there is no such thing as
// an input this may reject: a chain that could not start because its subject did
// not slugify would be refusing a DERIVED value at the one moment it must not.
// Every case below therefore ends in the same assertion — the result is a slug.

import { FEATURE_SLUG_PATTERN, UNNAMED_SUBJECT, featureSlugFrom } from './feature-slug'

const CHAIN = 'chain-lq3f8a-k9x2b7'

describe('featureSlugFrom: a subject for every aim', () => {
  it('reads back as the words somebody wrote', () => {
    expect(featureSlugFrom('Add a dark mode', CHAIN)).toBe('add-a-dark-mode-k9x2b7')
  })

  it('folds punctuation, spacing and case into hyphens', () => {
    expect(featureSlugFrom('  Fix the  LOGIN!! (again) ', CHAIN)).toBe('fix-the-login-again-k9x2b7')
  })

  it('folds accents rather than dropping the word', () => {
    // A person who wrote a word expects to recognise it in the filename.
    expect(featureSlugFrom('café crème brûlée', CHAIN)).toBe('cafe-creme-brulee-k9x2b7')
  })

  it('names the unnamed rather than producing nothing', () => {
    for (const aim of ['', '   ', '!!!', '日本語のみ', '🎉🎉', '---']) {
      const slug = featureSlugFrom(aim, CHAIN)
      expect(slug).toBe(`${UNNAMED_SUBJECT}-k9x2b7`)
      expect(slug).toMatch(FEATURE_SLUG_PATTERN)
    }
  })

  it('stays short enough to live in a filename', () => {
    const slug = featureSlugFrom(
      'Rework the entire notification subsystem including the delivery retries and the digest scheduler',
      CHAIN,
    )
    expect(slug.length).toBeLessThanOrEqual(56)
    expect(slug.endsWith('-k9x2b7')).toBe(true)
    expect(slug).toMatch(FEATURE_SLUG_PATTERN)
  })

  it('binds the subject to the run, so one chain’s proofs are its own', () => {
    // Two chains with the identical aim: without this, the older run's
    // documents would answer for the newer one's rungs — a stage that ended
    // cleanly and wrote nothing would be cleared by a file from last week,
    // which is the failure the gate exists to catch (#1915 C1's shape).
    expect(featureSlugFrom('add a dark mode', 'chain-aaa-111111')).not.toBe(
      featureSlugFrom('add a dark mode', 'chain-bbb-222222'),
    )
  })

  it('survives a chain id with nothing slug-shaped in it', () => {
    for (const chainId of ['', '---', '***']) {
      expect(featureSlugFrom('add a dark mode', chainId)).toMatch(FEATURE_SLUG_PATTERN)
    }
  })

  it('is valid for anything at all — the property, over a sweep of aims', () => {
    const aims = [
      '',
      ' ',
      '-',
      '_',
      '.',
      '../../etc/passwd',
      'feat/PF-42: do the thing',
      'ALLCAPS',
      '123',
      'ünïcödé',
      '🎉 party',
      'a'.repeat(500),
      'x '.repeat(200),
    ]
    for (const aim of aims) {
      const slug = featureSlugFrom(aim, CHAIN)
      expect(slug).toMatch(FEATURE_SLUG_PATTERN)
      expect(slug.length).toBeGreaterThan(0)
    }
  })
})
