import {
  parseConflictHunks,
  spliceConflictHunk,
  spliceConflictHunkWithText,
  spliceAllConflictHunks,
  hasConflictHunks,
  baseHunkId,
} from './conflict-hunks'

const twoHunks = [
  'top',
  '<<<<<<< HEAD',
  'A-ours',
  '=======',
  'A-theirs',
  '>>>>>>> feature',
  'middle',
  '<<<<<<< HEAD',
  'B-ours',
  '=======',
  'B-theirs',
  '>>>>>>> feature',
  'bottom',
].join('\n')

describe('parseConflictHunks', () => {
  it('captures both hunks with content + distinct ids', () => {
    const hunks = parseConflictHunks(twoHunks)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].oursText).toBe('A-ours')
    expect(hunks[0].theirsText).toBe('A-theirs')
    expect(hunks[1].oursText).toBe('B-ours')
    expect(hunks[0].hunkId).not.toBe(hunks[1].hunkId)
  })

  it('disambiguates duplicate-content hunks with an occurrence suffix', () => {
    const dup = [
      '<<<<<<< HEAD',
      'same',
      '=======',
      'other',
      '>>>>>>> f',
      '<<<<<<< HEAD',
      'same',
      '=======',
      'other',
      '>>>>>>> f',
    ].join('\n')
    const [a, b] = parseConflictHunks(dup)
    expect(a.hunkId).not.toBe(b.hunkId)
    expect(b.hunkId).toMatch(/-2$/)
  })
})

describe('spliceConflictHunk — single hunk, siblings untouched', () => {
  it('resolves the FIRST hunk with ours, leaving the second conflict intact', () => {
    const hunks = parseConflictHunks(twoHunks)
    const result = spliceConflictHunk(twoHunks, hunks[0].hunkId, 'ours')
    expect(result.matched).toBe(true)
    expect(result.remainingConflicts).toBe(1)
    expect(result.text).toBe(
      ['top', 'A-ours', 'middle', '<<<<<<< HEAD', 'B-ours', '=======', 'B-theirs', '>>>>>>> feature', 'bottom'].join(
        '\n',
      ),
    )
  })

  it('resolves the SECOND hunk with theirs, leaving the first conflict intact', () => {
    const hunks = parseConflictHunks(twoHunks)
    const result = spliceConflictHunk(twoHunks, hunks[1].hunkId, 'theirs')
    expect(result.remainingConflicts).toBe(1)
    expect(result.text).toBe(
      ['top', '<<<<<<< HEAD', 'A-ours', '=======', 'A-theirs', '>>>>>>> feature', 'middle', 'B-theirs', 'bottom'].join(
        '\n',
      ),
    )
  })

  it('both ordering — ours-first (default) vs theirs-first', () => {
    const hunks = parseConflictHunks(twoHunks)
    const oursFirst = spliceConflictHunk(twoHunks, hunks[0].hunkId, 'both')
    expect(oursFirst.text.split('\n').slice(1, 3)).toEqual(['A-ours', 'A-theirs'])
    const theirsFirst = spliceConflictHunk(twoHunks, hunks[0].hunkId, 'both', 'theirs-first')
    expect(theirsFirst.text.split('\n').slice(1, 3)).toEqual(['A-theirs', 'A-ours'])
  })

  it('returns matched:false for an unknown hunkId, text unchanged', () => {
    const result = spliceConflictHunk(twoHunks, 'hunk-nope', 'ours')
    expect(result.matched).toBe(false)
    expect(result.text).toBe(twoHunks)
    expect(result.remainingConflicts).toBe(2)
  })

  it('resolving both hunks in turn drives remainingConflicts to 0', () => {
    const first = spliceConflictHunk(twoHunks, parseConflictHunks(twoHunks)[0].hunkId, 'ours')
    const nextId = parseConflictHunks(first.text)[0].hunkId
    const second = spliceConflictHunk(first.text, nextId, 'theirs')
    expect(second.remainingConflicts).toBe(0)
    expect(hasConflictHunks(second.text)).toBe(false)
  })
})

describe('baseHunkId — occurrence-suffix stripping', () => {
  it('strips a trailing -N occurrence suffix, leaving the base36 digest intact', () => {
    expect(baseHunkId('hunk-abc123')).toBe('hunk-abc123')
    expect(baseHunkId('hunk-abc123-2')).toBe('hunk-abc123')
    expect(baseHunkId('hunk-abc123-10')).toBe('hunk-abc123')
  })
})

describe('duplicate-hunk resolution via base-digest fallback (Accept-all regression)', () => {
  // Two BYTE-IDENTICAL hunks: same ours/theirs content AND same marker labels.
  const dup = [
    'top',
    '<<<<<<< HEAD',
    'same-ours',
    '=======',
    'same-theirs',
    '>>>>>>> feature',
    'middle',
    '<<<<<<< HEAD',
    'same-ours',
    '=======',
    'same-theirs',
    '>>>>>>> feature',
    'bottom',
  ].join('\n')

  it('resolves the second identical hunk via its ORIGINALLY-cached id after the first is spliced', () => {
    const [first, second] = parseConflictHunks(dup)
    // Ids captured ONCE up front (the review-card / Accept-all path).
    expect(first.hunkId).toBe(baseHunkId(second.hunkId)) // hunk-x vs hunk-x-2
    expect(second.hunkId).toMatch(/-2$/)

    // Splice the first by its exact id.
    const afterFirst = spliceConflictHunk(dup, first.hunkId, 'ours')
    expect(afterFirst.matched).toBe(true)
    expect(afterFirst.remainingConflicts).toBe(1)

    // Now splice by the STALE cached second id against the modified text. The
    // survivor re-hashed to occurrence 1 (id lost its -2 suffix); the base-digest
    // fallback must still resolve it.
    const afterSecond = spliceConflictHunk(afterFirst.text, second.hunkId, 'ours')
    expect(afterSecond.matched).toBe(true)
    expect(afterSecond.remainingConflicts).toBe(0)
    expect(hasConflictHunks(afterSecond.text)).toBe(false)
    expect(afterSecond.text).toBe(['top', 'same-ours', 'middle', 'same-ours', 'bottom'].join('\n'))
  })

  it('spliceConflictHunkWithText applies the same base-digest fallback', () => {
    const [first, second] = parseConflictHunks(dup)
    const afterFirst = spliceConflictHunkWithText(dup, first.hunkId, 'merged')
    expect(afterFirst.matched).toBe(true)
    expect(afterFirst.remainingConflicts).toBe(1)

    const afterSecond = spliceConflictHunkWithText(afterFirst.text, second.hunkId, 'merged')
    expect(afterSecond.matched).toBe(true)
    expect(afterSecond.remainingConflicts).toBe(0)
    expect(afterSecond.text).toBe(['top', 'merged', 'middle', 'merged', 'bottom'].join('\n'))
  })

  it('a genuinely-gone hunk still reports matched:false (no false base-digest match)', () => {
    // Resolve BOTH duplicates, then a stale cached id must not match anything.
    const [first, second] = parseConflictHunks(dup)
    const afterFirst = spliceConflictHunk(dup, first.hunkId, 'ours')
    const afterSecond = spliceConflictHunk(afterFirst.text, second.hunkId, 'ours')
    const stale = spliceConflictHunk(afterSecond.text, second.hunkId, 'ours')
    expect(stale.matched).toBe(false)
    expect(stale.remainingConflicts).toBe(0)
  })
})

describe('diff3 base handling', () => {
  const diff3 = ['<<<<<<< HEAD', 'ours', '||||||| base', 'orig', '=======', 'theirs', '>>>>>>> f'].join('\n')

  it('drops the base section on ours/theirs resolve', () => {
    const id = parseConflictHunks(diff3)[0].hunkId
    expect(spliceConflictHunk(diff3, id, 'ours').text).toBe('ours')
    expect(spliceConflictHunk(diff3, id, 'theirs').text).toBe('theirs')
  })

  it('both concatenates only ours + theirs (never base)', () => {
    const id = parseConflictHunks(diff3)[0].hunkId
    expect(spliceConflictHunk(diff3, id, 'both').text).toBe('ours\ntheirs')
  })
})

describe('spliceAllConflictHunks — whole-file shim primitive', () => {
  it('resolves every hunk with the same choice → fully clean', () => {
    const result = spliceAllConflictHunks(twoHunks, 'ours')
    expect(result.matched).toBe(true)
    expect(result.remainingConflicts).toBe(0)
    expect(result.text).toBe(['top', 'A-ours', 'middle', 'B-ours', 'bottom'].join('\n'))
  })

  it('matched:false and unchanged when there are no conflicts', () => {
    const result = spliceAllConflictHunks('no conflicts here', 'ours')
    expect(result.matched).toBe(false)
    expect(result.text).toBe('no conflicts here')
  })

  it('preserves an empty side (delete/modify style) as a true removal', () => {
    const oneSided = ['<<<<<<< HEAD', 'kept', '=======', '>>>>>>> f'].join('\n')
    expect(spliceAllConflictHunks(oneSided, 'theirs').text).toBe('')
    expect(spliceAllConflictHunks(oneSided, 'ours').text).toBe('kept')
  })
})
