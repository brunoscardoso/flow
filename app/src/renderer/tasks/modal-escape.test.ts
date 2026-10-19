import { dismissOnEscape } from './modal-escape'
import { shouldLeaveExpandedOnEscape } from '../expand-right-model'

/** A KeyboardEvent stand-in that dispatches like the DOM: document (bubble), then window. */
function escapeThrough(documentListener: (event: ReturnType<typeof keyEvent>) => void) {
  const event = keyEvent('Escape')
  documentListener(event)
  return event
}

function keyEvent(key: string) {
  const event = {
    key,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault(): void {
      event.defaultPrevented = true
    },
    stopPropagation(): void {
      event.propagationStopped = true
    },
  }
  return event
}

describe('a board modal claims the Escape it closes on', () => {
  it('expanded right side + open dialog + Escape → only the dialog closes', () => {
    let modalOpen = true
    const event = escapeThrough((e) => dismissOnEscape(e, () => (modalOpen = false)))
    expect(modalOpen).toBe(false)
    // The shell's window listener: reached only if nothing stopped the key, and
    // even then the key reads as handled.
    const shellLeaves =
      !event.propagationStopped &&
      shouldLeaveExpandedOnEscape({
        expanded: true,
        handled: event.defaultPrevented,
        modalOpen, // the overlay is already gone
        popupOpen: false,
        editorWidgetOpen: false,
        focusInEditable: false,
      })
    expect(shellLeaves).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
  })

  it('the old handler (close without claiming) let the shell leave the expanded view too', () => {
    // Pins why the claim matters: same sequence, unclaimed.
    const event = escapeThrough(() => undefined)
    expect(
      shouldLeaveExpandedOnEscape({
        expanded: true,
        handled: event.defaultPrevented,
        modalOpen: false,
        popupOpen: false,
        editorWidgetOpen: false,
        focusInEditable: false,
      }),
    ).toBe(true)
  })

  it('any other key is left alone', () => {
    const event = keyEvent('Enter')
    let closed = false
    expect(dismissOnEscape(event, () => (closed = true))).toBe(false)
    expect(closed).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(event.propagationStopped).toBe(false)
  })
})

describe('every board modal goes through dismissOnEscape', () => {
  it('no modal closes on an unclaimed Escape', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path')
    const source = readFileSync(join(__dirname, 'kanban-board.ts'), 'utf8')
    expect(source).not.toMatch(/if \(event\.key === 'Escape'\) close\(\)/)
    expect(source.match(/dismissOnEscape\(event, close\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })
})
