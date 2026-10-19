import {
  FOLDER_BEHIND_MARKER_PREFIX,
  formatFolderBehindMarker,
  parseFolderBehindMarker,
} from './folder-behind-marker'

describe('folder-behind marker', () => {
  it('round-trips a branch and its upstream', () => {
    const content = formatFolderBehindMarker('main', 'origin/main')
    expect(content).toBe(`${FOLDER_BEHIND_MARKER_PREFIX} main origin/main`)
    expect(parseFolderBehindMarker(content ?? '')).toEqual({
      branch: 'main',
      upstream: 'origin/main',
    })
  })

  it('round-trips a nested branch name', () => {
    const content = formatFolderBehindMarker('feat/workspaces', 'upstream/feat/workspaces')
    expect(parseFolderBehindMarker(content ?? '')).toEqual({
      branch: 'feat/workspaces',
      upstream: 'upstream/feat/workspaces',
    })
  })

  it('writes nothing for a name it could not read back', () => {
    expect(formatFolderBehindMarker('', 'origin/main')).toBeNull()
    expect(formatFolderBehindMarker('main', '')).toBeNull()
    expect(formatFolderBehindMarker('my branch', 'origin/main')).toBeNull()
  })

  it('is not a marker when the row is any other system note', () => {
    expect(parseFolderBehindMarker('Interrupted by you')).toBeNull()
    expect(parseFolderBehindMarker('[artifact] plan flow/plans/plan_x_v1.md')).toBeNull()
    expect(parseFolderBehindMarker('')).toBeNull()
  })

  it('refuses a malformed marker rather than guessing at it', () => {
    // A marker is exactly two refs. Neither a missing upstream nor an extra
    // field may render as a card with half a sentence in it.
    expect(parseFolderBehindMarker(`${FOLDER_BEHIND_MARKER_PREFIX} main`)).toBeNull()
    expect(parseFolderBehindMarker(`${FOLDER_BEHIND_MARKER_PREFIX} main origin/main 7`)).toBeNull()
    expect(parseFolderBehindMarker(FOLDER_BEHIND_MARKER_PREFIX)).toBeNull()
  })
})
