// Every card menu returns the keyboard where it came from (#1730 — the #1300
// contract). attachMenuKeyboard restores focus on Escape only when an anchor
// was provided; the item and hunt menus offered keyboard opening (Shift+F10 /
// ContextMenu) yet mounted with `null`, stranding the keyboard user on <body>.
// The mount is DOM glue with no pure seam, so the pin is a source scan: no
// card-menu mount may pass a null anchor.
import { readFileSync } from 'fs'
import { join } from 'path'

describe('card menus mount with a focus anchor (#1730)', () => {
  it('no #mountCardMenu call passes null', () => {
    const src = readFileSync(join(__dirname, 'kanban-board.ts'), 'utf8')
    expect(src).not.toContain('#mountCardMenu(menu, x, y, null)')
  })
})
