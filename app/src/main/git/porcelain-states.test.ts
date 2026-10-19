import {
  conflictTypeFromStages,
  conflictTypeFromXY,
  letterToState,
  parsePorcelainStates,
} from './porcelain-states'

describe('letterToState (#335)', () => {
  it('maps a clean slot (. / absent) to null', () => {
    expect(letterToState('.')).toBeNull()
    expect(letterToState(undefined)).toBeNull()
  })

  it('maps each porcelain letter to its state', () => {
    expect(letterToState('A')).toBe('added')
    expect(letterToState('D')).toBe('deleted')
    expect(letterToState('R')).toBe('renamed')
    expect(letterToState('U')).toBe('conflicted')
  })

  it('maps M / T / C and anything unexpected to modified', () => {
    expect(letterToState('M')).toBe('modified')
    expect(letterToState('T')).toBe('modified')
    expect(letterToState('C')).toBe('modified')
    expect(letterToState('?')).toBe('modified')
  })
})

describe('parsePorcelainStates (#335)', () => {
  it('staged-only (index change, clean worktree): "M."', () => {
    expect(parsePorcelainStates('M.')).toEqual({ indexState: 'modified', worktreeState: null })
  })

  it('worktree-only (unstaged change): ".M"', () => {
    expect(parsePorcelainStates('.M')).toEqual({ indexState: null, worktreeState: 'modified' })
  })

  it('staged AND further modified: "MM" → present in both sections', () => {
    expect(parsePorcelainStates('MM')).toEqual({
      indexState: 'modified',
      worktreeState: 'modified',
    })
  })

  it('newly added, staged: "A."', () => {
    expect(parsePorcelainStates('A.')).toEqual({ indexState: 'added', worktreeState: null })
  })

  it('deleted in worktree, not staged: ".D"', () => {
    expect(parsePorcelainStates('.D')).toEqual({ indexState: null, worktreeState: 'deleted' })
  })

  it('clean pair "..": both null', () => {
    expect(parsePorcelainStates('..')).toEqual({ indexState: null, worktreeState: null })
  })
})

describe('conflictTypeFromXY (conflict-UX Phase 2)', () => {
  it.each([
    ['DD', 'both-deleted'],
    ['AU', 'added-by-us'],
    ['UD', 'deleted-by-them'],
    ['UA', 'added-by-them'],
    ['DU', 'deleted-by-us'],
    ['AA', 'both-added'],
    ['UU', 'both-modified'],
  ] as const)('maps %s → %s', (xy, type) => {
    expect(conflictTypeFromXY(xy)).toBe(type)
  })

  it('returns undefined for a pair git never emits for a `u` record', () => {
    expect(conflictTypeFromXY('..')).toBeUndefined()
    expect(conflictTypeFromXY('MM')).toBeUndefined()
    expect(conflictTypeFromXY('')).toBeUndefined()
  })
})

describe('conflictTypeFromStages (conflict-UX Phase 2)', () => {
  it.each([
    [{ ours: true, theirs: true, base: true }, 'both-modified'],
    [{ ours: true, theirs: true, base: false }, 'both-added'],
    [{ ours: true, theirs: false, base: true }, 'deleted-by-them'],
    [{ ours: true, theirs: false, base: false }, 'added-by-us'],
    [{ ours: false, theirs: true, base: true }, 'deleted-by-us'],
    [{ ours: false, theirs: true, base: false }, 'added-by-them'],
    [{ ours: false, theirs: false, base: true }, 'both-deleted'],
  ] as const)('%o → %s', (stages, type) => {
    expect(conflictTypeFromStages(stages)).toBe(type)
  })

  it('is consistent with conflictTypeFromXY for every valid u-record code', () => {
    // Stage presence ⇔ XY code — the two derivations must never disagree.
    expect(conflictTypeFromStages({ ours: true, theirs: true, base: true })).toBe(
      conflictTypeFromXY('UU'),
    )
    expect(conflictTypeFromStages({ ours: true, theirs: true, base: false })).toBe(
      conflictTypeFromXY('AA'),
    )
    expect(conflictTypeFromStages({ ours: true, theirs: false, base: true })).toBe(
      conflictTypeFromXY('UD'),
    )
    expect(conflictTypeFromStages({ ours: false, theirs: true, base: true })).toBe(
      conflictTypeFromXY('DU'),
    )
    expect(conflictTypeFromStages({ ours: false, theirs: false, base: true })).toBe(
      conflictTypeFromXY('DD'),
    )
  })

  it('returns undefined when no stage is present (not an unmerged entry)', () => {
    expect(conflictTypeFromStages({ ours: false, theirs: false, base: false })).toBeUndefined()
  })
})
