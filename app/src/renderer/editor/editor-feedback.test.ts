import {
  errorText,
  fileDeletedOnDiskToast,
  fileOpFailedToast,
  hunkResolveFailedToast,
  hunkScopeConfirmText,
  hunkStaleToast,
  saveFailedToast,
  listDirFailedToast,
  listDirFailureHint,
} from './editor-feedback'

describe('fileDeletedOnDiskToast (#294)', () => {
  it('names the file and warns that a save recreates it, at error level', () => {
    const toast = fileDeletedOnDiskToast('src/foo.ts')
    expect(toast.title).toBe('File deleted on disk')
    expect(toast.body).toContain('src/foo.ts')
    expect(toast.body).toMatch(/recreate/i)
    expect(toast.level).toBe('error')
  })
})

describe('errorText', () => {
  it('reads an Error message, and degrades unknown throws gracefully', () => {
    expect(errorText(new Error('EACCES: permission denied'))).toBe('EACCES: permission denied')
    expect(errorText('disk full')).toBe('disk full')
    expect(errorText({})).toBe('Unknown error') // avoids "[object Object]"
  })
})

describe('saveFailedToast (#195)', () => {
  it('names the file, carries the error, and states the change is not on disk', () => {
    const toast = saveFailedToast('src/app.ts', new Error('EACCES: permission denied'))
    expect(toast).toEqual({
      title: 'Save failed',
      body: 'src/app.ts — EACCES: permission denied. Your change is not on disk.',
      level: 'error',
    })
  })
})

describe('fileOpFailedToast (#196)', () => {
  it('titles by operation and shows the basename, with the error as the body', () => {
    expect(fileOpFailedToast('create', 'src/util/new.ts', new Error('already exists'))).toEqual({
      title: "Couldn't create new.ts",
      body: 'already exists',
      level: 'error',
    })
    expect(fileOpFailedToast('rename', 'src/util/renamed.ts', new Error('name exists'))).toEqual({
      title: "Couldn't rename renamed.ts",
      body: 'name exists',
      level: 'error',
    })
  })

  it('handles a trailing-slash directory path and a bare name', () => {
    expect(fileOpFailedToast('delete', 'src/oldDir/', new Error('not empty')).title).toBe(
      "Couldn't delete oldDir",
    )
    expect(fileOpFailedToast('create', 'top.ts', new Error('bad')).title).toBe(
      "Couldn't create top.ts",
    )
  })
})

describe('agent-edit review feedback (#1290, #1291)', () => {
  it('names the file and states nothing changed when a review action fails', () => {
    // The ✓/✗ became a silent dead click: the IPC rejected, the renderer
    // logged to console, and nothing on screen moved.
    const toast = hunkResolveFailedToast('logger.js', new Error('Unknown or already-resolved hunk'))
    expect(toast.level).toBe('error')
    expect(toast.body).toContain('logger.js')
    expect(toast.body).toContain('Nothing was changed')
  })

  it('treats a moved-on file as information, not an error', () => {
    // Hunk ids embed position + content hash, so any edit invalidates them.
    // Nothing is broken — the view was stale.
    const toast = hunkStaleToast('logger.js')
    expect(toast.level).toBe('info')
    expect(toast.body).toContain('refreshed')
  })

  it('names the real blast radius before a reject that would eat user edits', () => {
    // The count said "1 pending hunk"; the revert covered two, and the second
    // was the user's own uncommitted line.
    const text = hunkScopeConfirmText('logger.js', 'reject', 2, 1)
    expect(text).toContain('logger.js')
    expect(text).toContain('2 pending changes, not 1')
    expect(text).toContain('1 was made outside this review')
    expect(text).toContain('cannot be recovered')
    expect(text).toContain('Reject all 2?')
  })

  it('does not threaten data loss for an ACCEPT, which destroys nothing', () => {
    const text = hunkScopeConfirmText('logger.js', 'accept', 3, 1)
    expect(text).toContain('Accept all 3?')
    expect(text).not.toContain('cannot be recovered')
  })
})

// #1464 — EACCES missed the missing-path regex by one error code, so an
// unreadable folder fell into the "console-only" carve-out and the tree rendered
// it as an ordinary EMPTY project: byte-identical to a genuinely empty one,
// while Source Control and Review both toasted about the same folder.
describe('unreadable project folders (#1464)', () => {
  const EACCES = new Error("EACCES: permission denied, scandir '/tmp/ro'")
  const EPERM = new Error("EPERM: operation not permitted, scandir '/tmp/tcc'")
  const ENOENT = new Error("ENOENT: no such file or directory, scandir '/tmp/gone'")

  it('toasts a permission failure instead of staying silent', () => {
    const toast = listDirFailedToast('ro-project', EACCES)
    expect(toast).not.toBeNull()
    expect(toast!.title).toMatch(/read/i)
    expect(toast!.body).toContain('ro-project')
    expect(toast!.level).toBe('error')
  })

  it('covers EPERM too — macOS TCC gives that, not EACCES', () => {
    expect(listDirFailedToast('tcc-project', EPERM)).not.toBeNull()
  })

  it('still says "not found" for a vanished folder — #1118 is unchanged', () => {
    const toast = listDirFailedToast('gone-project', ENOENT)
    expect(toast!.title).toBe('Project folder not found')
  })

  it('keeps an unrecognised failure console-only, as before', () => {
    expect(listDirFailedToast('x', new Error('EIO: i/o error'))).toBeNull()
  })

  describe('the pane hint', () => {
    it('distinguishes "cannot read" from "not there"', () => {
      expect(listDirFailureHint(EACCES)).toMatch(/permission denied/i)
      expect(listDirFailureHint(ENOENT)).toMatch(/on disk/i)
      expect(listDirFailureHint(EACCES)).not.toBe(listDirFailureHint(ENOENT))
    })

    it('is null for an unrecognised failure — no mystery text in the pane', () => {
      expect(listDirFailureHint(new Error('EIO: i/o error'))).toBeNull()
    })
  })
})
