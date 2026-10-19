import {
  folderFreshnessVerdict,
  parseAheadBehind,
  parseUpstreamName,
  type FolderFreshnessFacts,
} from './folder-freshness'

const facts = (over: Partial<FolderFreshnessFacts> = {}): FolderFreshnessFacts => ({
  hasOwnCheckout: false,
  branch: 'main',
  upstream: 'origin/main',
  distance: { ahead: 0, behind: 7 },
  ...over,
})

describe('parseAheadBehind', () => {
  it('reads git’s two tab-separated counts', () => {
    expect(parseAheadBehind('0\t7\n')).toEqual({ ahead: 0, behind: 7 })
    expect(parseAheadBehind('2\t7')).toEqual({ ahead: 2, behind: 7 })
    expect(parseAheadBehind('0\t0\n')).toEqual({ ahead: 0, behind: 0 })
  })

  it('answers null for anything it cannot read', () => {
    // Each of these means "say nothing", never "nothing is behind" — the
    // second would be a claim.
    expect(parseAheadBehind('')).toBeNull()
    expect(parseAheadBehind('\n')).toBeNull()
    expect(parseAheadBehind('7')).toBeNull()
    expect(parseAheadBehind('fatal: no upstream configured')).toBeNull()
    expect(parseAheadBehind('1\t2\t3')).toBeNull()
    expect(parseAheadBehind('x\ty')).toBeNull()
  })
})

describe('parseUpstreamName', () => {
  it('reads the tracking branch’s short name', () => {
    expect(parseUpstreamName('origin/main\n')).toBe('origin/main')
    expect(parseUpstreamName('upstream/feat/x')).toBe('upstream/feat/x')
  })

  it('answers null when there is nothing usable', () => {
    expect(parseUpstreamName('')).toBeNull()
    expect(parseUpstreamName('  \n')).toBeNull()
    // A name a marker could not round-trip is refused here rather than later.
    expect(parseUpstreamName('origin/my branch')).toBeNull()
  })
})

describe('folderFreshnessVerdict', () => {
  it('notes a folder behind its upstream', () => {
    expect(folderFreshnessVerdict(facts())).toEqual({
      note: true,
      branch: 'main',
      upstream: 'origin/main',
      behind: 7,
      ahead: 0,
    })
  })

  it('notes a diverged folder too — it is the state most worth knowing', () => {
    const verdict = folderFreshnessVerdict(facts({ distance: { ahead: 2, behind: 7 } }))
    expect(verdict).toMatchObject({ note: true, behind: 7, ahead: 2 })
  })

  it('says nothing for a thread that has a copy of its own', () => {
    // That path already started from the latest: the cut fetches the base and
    // the checkout is put on it.
    expect(folderFreshnessVerdict(facts({ hasOwnCheckout: true }))).toEqual({
      note: false,
      reason: 'own-checkout',
    })
  })

  it('says nothing when the folder is current', () => {
    expect(folderFreshnessVerdict(facts({ distance: { ahead: 0, behind: 0 } }))).toEqual({
      note: false,
      reason: 'current',
    })
  })

  it('says nothing when there is no branch or no upstream', () => {
    expect(folderFreshnessVerdict(facts({ branch: null }))).toEqual({
      note: false,
      reason: 'no-branch',
    })
    expect(folderFreshnessVerdict(facts({ branch: '' }))).toEqual({
      note: false,
      reason: 'no-branch',
    })
    expect(folderFreshnessVerdict(facts({ upstream: null }))).toEqual({
      note: false,
      reason: 'no-upstream',
    })
  })

  it('treats an unreadable distance as unknown, not as current', () => {
    // A fetch that timed out and a git that failed both land here. Reporting
    // "current" would turn a missing answer into a reassurance.
    expect(folderFreshnessVerdict(facts({ distance: null }))).toEqual({
      note: false,
      reason: 'unreadable',
    })
  })
})
