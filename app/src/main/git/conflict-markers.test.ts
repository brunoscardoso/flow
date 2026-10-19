// Pure half of the #986 unresolved-conflict detection: the marker-line content
// test and the refusal wording shared by the stage/approve and commit gates.

import {
  commitConflictRefusal,
  CONFLICT_MARKER_GREP,
  containsConflictMarkers,
  stageConflictRefusal,
} from './conflict-markers'

describe('containsConflictMarkers (#986)', () => {
  it('detects the marker triple exactly as git writes it', () => {
    const conflicted = [
      'export const version = 0',
      '<<<<<<< HEAD',
      'export const version = 3 // main',
      '=======',
      'export const version = 2 // feature',
      '>>>>>>> feature',
      '',
    ].join('\n')
    expect(containsConflictMarkers(conflicted)).toBe(true)
  })

  it('detects each marker line independently (partial resolutions)', () => {
    expect(containsConflictMarkers('a\n<<<<<<< HEAD\nb\n')).toBe(true)
    expect(containsConflictMarkers('a\n=======\nb\n')).toBe(true)
    expect(containsConflictMarkers('a\n>>>>>>> feature\nb\n')).toBe(true)
  })

  it('detects diff3-style base markers', () => {
    expect(containsConflictMarkers('x\n||||||| merged common ancestors\ny\n')).toBe(true)
  })

  it('detects markers with CRLF line endings', () => {
    expect(containsConflictMarkers('a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> f\r\n')).toBe(
      true,
    )
  })

  it('does NOT match markers quoted mid-line or indented (docs/fixtures)', () => {
    expect(containsConflictMarkers("const s = '<<<<<<< HEAD'\n")).toBe(false)
    expect(containsConflictMarkers('  <<<<<<< HEAD\n')).toBe(false)
    expect(containsConflictMarkers('// see ======= separators\n')).toBe(false)
    expect(containsConflictMarkers('a >>>>>>> b\n')).toBe(false)
  })

  it('does NOT match near-miss runs (wrong length or trailing text on =======)', () => {
    expect(containsConflictMarkers('<<<<<< HEAD\n')).toBe(false) // 6, not 7
    expect(containsConflictMarkers('========\n')).toBe(false) // 8 equals
    expect(containsConflictMarkers('======= separator\n')).toBe(false) // git writes it bare
    expect(containsConflictMarkers('')).toBe(false)
  })
})

describe('CONFLICT_MARKER_GREP agrees with the JS regex (#1685)', () => {
  // git grep splits blobs on LF and tests each line standalone, CR retained —
  // so compiling the ERE as a JS regex against a single line emulates exactly
  // what the commit gate's subprocess sees. This pattern uses only syntax the
  // two dialects share.
  const grepLine = new RegExp(CONFLICT_MARKER_GREP)

  const markerLines = ['<<<<<<< HEAD', '=======', '>>>>>>> feature', '||||||| base', '<<<<<<<']
  const nonMarkerLines = ['  <<<<<<< HEAD', '========', '======= separator', "const s = '======='"]

  it.each(markerLines)('both match %j with and without a trailing CR', (line) => {
    expect(grepLine.test(line)).toBe(true)
    expect(grepLine.test(`${line}\r`)).toBe(true)
    expect(containsConflictMarkers(`${line}\n`)).toBe(true)
    expect(containsConflictMarkers(`${line}\r\n`)).toBe(true)
  })

  it.each(nonMarkerLines)('neither matches %j', (line) => {
    expect(grepLine.test(line)).toBe(false)
    expect(grepLine.test(`${line}\r`)).toBe(false)
    expect(containsConflictMarkers(`${line}\n`)).toBe(false)
    expect(containsConflictMarkers(`${line}\r\n`)).toBe(false)
  })

  it('catches the CRLF equals separator the bare-$ pattern missed (#1685)', () => {
    expect(grepLine.test('=======\r')).toBe(true)
  })
})

describe('refusal messages (#986)', () => {
  it('stage refusal names the paths and points at the resolver', () => {
    const message = stageConflictRefusal(['app.ts'])
    expect(message).toContain('Cannot stage 1 file with unresolved merge conflicts (app.ts)')
    expect(message).toContain('inline conflict resolver')
    expect(message).toContain('Merge Changes')
  })

  it('commit refusal names the paths and points at the resolver', () => {
    const message = commitConflictRefusal(['a.ts', 'b.ts'])
    expect(message).toContain('Cannot commit — 2 files still carry unresolved conflict markers')
    expect(message).toContain('a.ts, b.ts')
    expect(message).toContain('Merge Changes')
  })

  it('caps long path lists so the toast stays readable', () => {
    const message = stageConflictRefusal(['a', 'b', 'c', 'd', 'e'])
    expect(message).toContain('a, b, c, …')
    expect(message).not.toContain('d, e')
  })
})
