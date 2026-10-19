import { deleteConfirmMessage, deleteConfirmWarning } from './delete-confirm'

describe('deleteConfirmMessage (#1187)', () => {
  it('leaves the single-file confirm exactly as it was', () => {
    expect(deleteConfirmMessage({ name: 'doomed.ts', kind: 'file', childCount: null })).toBe(
      'Delete doomed.ts?',
    )
    expect(deleteConfirmWarning({ name: 'doomed.ts', kind: 'file', childCount: null })).toBeNull()
  })

  it('says FOLDER and counts what is inside — the row is collapsed by default', () => {
    expect(deleteConfirmMessage({ name: 'service', kind: 'directory', childCount: 5 })).toBe(
      'Delete the folder service and all 5 items inside it?',
    )
  })

  it('singularises one item', () => {
    expect(deleteConfirmMessage({ name: 'svc', kind: 'directory', childCount: 1 })).toBe(
      'Delete the folder svc and all 1 item inside it?',
    )
  })

  it('says empty rather than claiming 0 items', () => {
    expect(deleteConfirmMessage({ name: 'svc', kind: 'directory', childCount: 0 })).toBe(
      'Delete the folder svc (empty)?',
    )
  })

  it('still names the folder when the listing is unavailable', () => {
    expect(deleteConfirmMessage({ name: 'svc', kind: 'directory', childCount: null })).toBe(
      'Delete the folder svc and everything inside it?',
    )
  })

  it('says where the bytes go, naming the contents git never shows', () => {
    // The recovery path gitignored files never had — and `git status` after a
    // delete doesn't even list them, so the copy has to.
    const warning = deleteConfirmWarning({ name: 'svc', kind: 'directory', childCount: 3 })
    expect(warning).toContain('Trash')
    expect(warning).toContain('.env')
  })
})
