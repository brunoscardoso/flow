import { changesetFingerprint, resolveChangesetMode } from './changeset-mode'

const map = (entries: Array<[string, number]>): Map<string, number> => new Map(entries)

describe('changesetFingerprint', () => {
  it('is stable across insertion order', () => {
    expect(changesetFingerprint(map([['module:b', 2], ['module:a', 1]]))).toBe(
      changesetFingerprint(map([['module:a', 1], ['module:b', 2]])),
    )
  })

  it('changes when membership or counts change', () => {
    const base = changesetFingerprint(map([['module:a', 1]]))
    expect(changesetFingerprint(map([['module:a', 2]]))).not.toBe(base)
    expect(changesetFingerprint(map([['module:a', 1], ['module:b', 1]]))).not.toBe(base)
  })
})

describe('resolveChangesetMode (#898)', () => {
  it('activates with changes, no stronger owner, not dismissed', () => {
    const state = resolveChangesetMode({
      changedByCard: map([['module:billing', 6], ['module:payments', 5]]),
      otherDecorationActive: false,
      dismissedFingerprint: null,
    })
    expect(state.active).toBe(true)
    expect(state.litCardIds).toEqual(['module:billing', 'module:payments'])
    expect(state.totalFiles).toBe(11)
    expect(state.chipLabel).toBe('11 changed files')
    expect(state.chipVisible).toBe(true)
  })

  it('is inactive on a clean tree (no chip either)', () => {
    const state = resolveChangesetMode({
      changedByCard: map([]),
      otherDecorationActive: false,
      dismissedFingerprint: null,
    })
    expect(state.active).toBe(false)
    expect(state.chipVisible).toBe(false)
    expect(state.chipLabel).toBe('')
  })

  it('yields to a stronger decoration owner but keeps the chip', () => {
    const state = resolveChangesetMode({
      changedByCard: map([['module:a', 1]]),
      otherDecorationActive: true,
      dismissedFingerprint: null,
    })
    expect(state.active).toBe(false)
    expect(state.chipVisible).toBe(true)
  })

  it('dismissal hides layer AND chip for the same fingerprint only', () => {
    const changed = map([['module:a', 1]])
    const fp = changesetFingerprint(changed)
    const dismissed = resolveChangesetMode({
      changedByCard: changed,
      otherDecorationActive: false,
      dismissedFingerprint: fp,
    })
    expect(dismissed.active).toBe(false)
    expect(dismissed.chipVisible).toBe(false)

    // A different changeset re-arms.
    const rearmed = resolveChangesetMode({
      changedByCard: map([['module:a', 2]]),
      otherDecorationActive: false,
      dismissedFingerprint: fp,
    })
    expect(rearmed.active).toBe(true)
    expect(rearmed.chipVisible).toBe(true)
  })

  it('singular label for one file', () => {
    const state = resolveChangesetMode({
      changedByCard: map([['module:a', 1]]),
      otherDecorationActive: false,
      dismissedFingerprint: null,
    })
    expect(state.chipLabel).toBe('1 changed file')
  })
})
