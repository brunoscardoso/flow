import {
  newAutoVerifyCandidates,
  parseDocAutoVerify,
  unadjudicatedSet,
} from './doc-auto-verify'

describe('parseDocAutoVerify', () => {
  it('defaults OFF; accepts colon/equals true only', () => {
    expect(parseDocAutoVerify(null)).toBe(false)
    expect(parseDocAutoVerify('autopilot: true\n')).toBe(false)
    expect(parseDocAutoVerify('doc_auto_verify: true\n')).toBe(true)
    expect(parseDocAutoVerify('doc_auto_verify=true\n')).toBe(true)
    expect(parseDocAutoVerify('doc_auto_verify: false\n')).toBe(false)
  })
})

describe('newAutoVerifyCandidates', () => {
  const f = (path: string, verdict = 'unadjudicated', stale?: boolean) => ({ path, verdict, ...(stale !== undefined ? { stale } : {}) })

  it('first snapshot yields nothing — the backlog never auto-storms', () => {
    expect(newAutoVerifyCandidates(null, [f('a.md'), f('b.md')])).toEqual([])
  })

  it('only ARRIVALS qualify: docs unadjudicated now that were not before', () => {
    const prev = new Set(['old.md'])
    expect(newAutoVerifyCandidates(prev, [f('old.md'), f('new.md')])).toEqual(['new.md'])
  })

  it('stale-revoked verdicts are never auto-re-verified', () => {
    const prev = new Set<string>()
    expect(newAutoVerifyCandidates(prev, [f('doc.md', 'corroborated', true)])).toEqual([])
  })

  it('unadjudicatedSet snapshots the current unverified names', () => {
    expect([...unadjudicatedSet([f('a.md'), f('b.md', 'corroborated')])]).toEqual(['a.md'])
  })
})
