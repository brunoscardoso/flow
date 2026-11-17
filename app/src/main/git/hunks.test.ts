import { hunkDigest, parseSingleFileDiff, publicHunks, selectHunk } from './hunks'

const RAW = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -2,0 +3,2 @@ function one() {',
  '+added one',
  '+added two',
  '@@ -10 +12 @@',
  '-old ten',
  '+new ten',
  '',
].join('\n')

describe('parseSingleFileDiff', () => {
  it('splits the file header from each -U0 hunk, with numbers and a digest', () => {
    const parsed = parseSingleFileDiff(RAW)
    expect(parsed).not.toBeNull()
    expect(parsed?.fileHeader).toBe(
      'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n',
    )
    expect(parsed?.hunks).toHaveLength(2)
    expect(parsed?.hunks[0]).toMatchObject({
      index: 0,
      header: '@@ -2,0 +3,2 @@',
      oldStart: 2,
      oldLines: 0,
      newStart: 3,
      newLines: 2,
      body: '+added one\n+added two\n',
    })
    // A count omitted by git means one line.
    expect(parsed?.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 12, newLines: 1 })
    expect(parsed?.hunks[1]?.digest).toBe(hunkDigest('@@ -10 +12 @@', '-old ten\n+new ten\n'))
  })

  it('answers null for no change and for a diff naming two files', () => {
    expect(parseSingleFileDiff('')).toBeNull()
    const two = `${RAW}diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n`
    expect(parseSingleFileDiff(two)).toBeNull()
  })

  it('keeps the no-newline marker inside the hunk it belongs to', () => {
    const raw = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n'
    expect(parseSingleFileDiff(raw)?.hunks[0]?.body).toBe('-a\n\\ No newline at end of file\n+b\n')
  })
})

describe('selectHunk', () => {
  const parsed = parseSingleFileDiff(RAW)

  it('builds a one-hunk patch when header and digest still match', () => {
    const hunk = parsed?.hunks[1]
    const result = selectHunk(parsed, 1, hunk?.header ?? '', hunk?.digest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patch).toBe(
      'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10 +12 @@\n-old ten\n+new ten\n',
    )
  })

  it('refuses when the hunk at that index is a different one now', () => {
    const result = selectHunk(parsed, 0, '@@ -10 +12 @@')
    expect(result).toMatchObject({ ok: false, reason: 'moved' })
  })

  it('refuses when the header matches but the lines do not', () => {
    const hunk = parsed?.hunks[0]
    const result = selectHunk(parsed, 0, hunk?.header ?? '', 'not-the-digest')
    expect(result).toMatchObject({ ok: false, reason: 'moved' })
  })

  it('refuses an index past the end, and a file with no changes left', () => {
    expect(selectHunk(parsed, 5, '@@ -1 +1 @@')).toMatchObject({ ok: false, reason: 'gone' })
    expect(selectHunk(parsed, -1, '@@ -1 +1 @@')).toMatchObject({ ok: false, reason: 'gone' })
    expect(selectHunk(null, 0, '@@ -1 +1 @@')).toMatchObject({ ok: false, reason: 'gone' })
  })

  it('names no command in any refusal (forbidden #12)', () => {
    for (const result of [selectHunk(parsed, 9, 'x'), selectHunk(parsed, 0, 'x'), selectHunk(null, 0, 'x')]) {
      if (result.ok) throw new Error('expected a refusal')
      expect(result.detail).not.toMatch(/\bgit\b|`/)
    }
  })
})

describe('publicHunks', () => {
  it('drops the bodies and caps the list', () => {
    const parsed = parseSingleFileDiff(RAW)
    const { hunks, truncated } = publicHunks(parsed, 1)
    expect(truncated).toBe(true)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).not.toHaveProperty('body')
    expect(publicHunks(null, 10)).toEqual({ hunks: [], truncated: false })
  })
})
