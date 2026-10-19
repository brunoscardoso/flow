import {
  CLAIM_TIER_LEGEND,
  explainProvenance,
  explainRollup,
  explainVerdict,
  explainWhen,
} from './doc-trust-explain'

// #1131: the list showed verdicts, a rollup, a tier and ⚙/✓/✕ buttons and
// explained none of them — clicking a row just opened the file.

describe('explainVerdict (#1131)', () => {
  it('says what contradicted MEANS and what to do about it', () => {
    const explanation = explainVerdict('contradicted')
    expect(explanation.label).toBe('contradicted')
    expect(explanation.meaning).toContain('Trust the code')
    expect(explanation.nextStep).toContain('verify again')
  })

  it('distinguishes “nobody checked” from “could not be checked”', () => {
    // Both render as the same "unverified" pill, which is exactly why the
    // explanation has to tell them apart.
    expect(explainVerdict('unadjudicated').label).toBe('unverified')
    expect(explainVerdict('unverifiable').label).toBe('unverified')
    expect(explainVerdict('unadjudicated').meaning).toContain('Nobody has checked')
    expect(explainVerdict('unverifiable').meaning).toContain('could not tell')
  })

  it('lets stale override the verdict it replaces', () => {
    // Reporting "verified" for an expired stamp is the lie the tier system
    // exists to prevent.
    const stale = explainVerdict('corroborated', { stale: true })
    expect(stale.label).toBe('stale')
    expect(stale.meaning).toContain('no longer means anything')
    expect(stale.nextStep).toContain('Re-verify')
  })
})

describe('explainProvenance (#1131)', () => {
  it('names the decider in words, not an enum', () => {
    expect(explainProvenance('user')).toBe('you marked this yourself')
    expect(explainProvenance('verify-agent')).toContain('verification agent')
    expect(explainProvenance('learn-pass')).toContain('learn pass')
  })

  it('is honest when nothing was recorded', () => {
    expect(explainProvenance(undefined)).toBe('origin not recorded')
    expect(explainProvenance('something-new')).toBe('origin not recorded')
  })
})

describe('explainWhen (#1131)', () => {
  const now = new Date('2026-08-06T12:00:00Z')

  it('reads as an age, since a verdict’s age is what makes it trustworthy', () => {
    expect(explainWhen('2026-08-06T11:59:30Z', now)).toBe('just now')
    expect(explainWhen('2026-08-06T11:30:00Z', now)).toBe('30 minutes ago')
    expect(explainWhen('2026-08-06T09:00:00Z', now)).toBe('3 hours ago')
    expect(explainWhen('2026-08-03T12:00:00Z', now)).toBe('3 days ago')
  })

  it('singularises', () => {
    expect(explainWhen('2026-08-05T12:00:00Z', now)).toBe('1 day ago')
  })

  it('returns null for missing or malformed stamps', () => {
    expect(explainWhen(undefined, now)).toBeNull()
    expect(explainWhen('not a date', now)).toBeNull()
  })
})

describe('explainRollup (#1131)', () => {
  it('spells the numbers out', () => {
    expect(explainRollup({ corroborated: 5, contradicted: 1, unverifiable: 1 })).toContain(
      '5 claims the code confirms',
    )
  })

  it('states the rule that one failure decides the doc', () => {
    expect(explainRollup({ corroborated: 5, contradicted: 1, unverifiable: 0 })).toContain(
      'One contradicted claim makes the whole doc contradicted.',
    )
  })

  it('omits that rule when nothing is contradicted', () => {
    expect(explainRollup({ corroborated: 5, contradicted: 0, unverifiable: 1 })).not.toContain(
      'One contradicted',
    )
  })

  it('singularises a single claim', () => {
    expect(explainRollup({ corroborated: 1, contradicted: 0, unverifiable: 0 })).toContain(
      '1 claim the code confirms',
    )
  })
})

describe('legends (#1131)', () => {
  it('answers “why is this Tier 2?” — the question the tier never explained', () => {
    expect(CLAIM_TIER_LEGEND).toContain('Tier-2')
    expect(CLAIM_TIER_LEGEND).toContain('Code is Tier 1')
  })
})
