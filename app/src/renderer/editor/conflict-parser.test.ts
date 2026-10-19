import { hasConflicts, modelHasConflictMarker, parseConflicts } from './conflict-parser'

const twoWay = ['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch', 'z'].join('\n')

describe('parseConflicts', () => {
  it('finds a two-way block with 1-based line range', () => {
    expect(parseConflicts(twoWay)).toMatchObject([{ startLine: 2, endLine: 6 }])
  })

  it('captures per-side content, labels, and a stable hunkId', () => {
    const [block] = parseConflicts(twoWay)
    expect(block.oursText).toBe('ours')
    expect(block.theirsText).toBe('theirs')
    expect(block.baseText).toBeUndefined()
    expect(block.oursLabel).toBe('HEAD')
    expect(block.theirsLabel).toBe('branch')
    expect(block.hunkId).toMatch(/^hunk-/)
    // hunkId is stable across identical parses.
    expect(parseConflicts(twoWay)[0].hunkId).toBe(block.hunkId)
  })

  it('finds a diff3 block (with ||||||| base section) and captures baseText', () => {
    const diff3 = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| base',
      'original',
      '=======',
      'theirs',
      '>>>>>>> other',
    ].join('\n')
    const [block] = parseConflicts(diff3)
    expect(block).toMatchObject({ startLine: 1, endLine: 7 })
    expect(block.oursText).toBe('ours')
    expect(block.baseText).toBe('original')
    expect(block.theirsText).toBe('theirs')
  })

  it('finds multiple blocks with distinct hunkIds', () => {
    const text = [
      '<<<<<<< a',
      'oneOurs',
      '=======',
      'oneTheirs',
      '>>>>>>> b',
      'middle',
      '<<<<<<< c',
      'twoOurs',
      '=======',
      'twoTheirs',
      '>>>>>>> d',
    ].join('\n')
    const blocks = parseConflicts(text)
    expect(blocks).toMatchObject([
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 11 },
    ])
    expect(blocks[0].hunkId).not.toBe(blocks[1].hunkId)
  })

  it('captures a multi-line side verbatim', () => {
    const text = ['<<<<<<< HEAD', 'l1', 'l2', '=======', 't1', '>>>>>>> b'].join('\n')
    const [block] = parseConflicts(text)
    expect(block.oursText).toBe('l1\nl2')
    expect(block.theirsText).toBe('t1')
  })

  it('skips an unterminated block (no >>>>>>> before EOF)', () => {
    expect(parseConflicts('<<<<<<< HEAD\nours\n=======\ntheirs')).toEqual([])
  })

  it('skips a block with no separator', () => {
    expect(parseConflicts('<<<<<<< HEAD\nstuff\n>>>>>>> branch')).toEqual([])
  })

  it('a second opener abandons the prior unterminated block', () => {
    const text = ['<<<<<<< a', 'ours', '<<<<<<< b', '=======', '>>>>>>> c'].join('\n')
    expect(parseConflicts(text)).toMatchObject([{ startLine: 3, endLine: 5 }])
  })

  it('returns [] for conflict-free text and reports hasConflicts', () => {
    expect(parseConflicts('just\nnormal\ncode')).toEqual([])
    expect(hasConflicts('just code')).toBe(false)
    expect(hasConflicts(twoWay)).toBe(true)
  })

  it('does not match markers that lack the boundary (e.g. <<<<<<<<)', () => {
    // 8 chars then a non-space — not a valid marker.
    expect(parseConflicts('<<<<<<<<x\n=======\n>>>>>>> b')).toEqual([])
  })
})

describe('modelHasConflictMarker', () => {
  /** Stub of the one findMatches capability the probe uses, recording its args. */
  function stubModel(text: string) {
    const calls: unknown[][] = []
    return {
      calls,
      findMatches(
        searchString: string,
        _editableOnly: boolean,
        _isRegex: boolean,
        _matchCase: boolean,
        _wordSeparators: string | null,
        _captureMatches: boolean,
        limitResultCount?: number,
      ): unknown[] {
        calls.push([searchString, limitResultCount])
        const hits: unknown[] = []
        let from = text.indexOf(searchString)
        while (from !== -1 && hits.length < (limitResultCount ?? Infinity)) {
          hits.push({ index: from })
          from = text.indexOf(searchString, from + 1)
        }
        return hits
      },
    }
  }

  it('is false for a marker-free buffer and true when a marker exists', () => {
    expect(modelHasConflictMarker(stubModel('just\nnormal\ncode'))).toBe(false)
    expect(modelHasConflictMarker(stubModel(twoWay))).toBe(true)
  })

  it('asks the model search for at most one <<<<<<< hit — never the full text', () => {
    const model = stubModel(`${twoWay}\n${twoWay}`)
    expect(modelHasConflictMarker(model)).toBe(true)
    expect(model.calls).toEqual([['<<<<<<<', 1]])
  })
})
