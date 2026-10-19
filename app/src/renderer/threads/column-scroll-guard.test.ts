import { createColumnScrollGuard, MAX_COLUMN_SCROLL_REPORTS, type ScrollBox } from './column-scroll-guard'

function fakeBox(): ScrollBox & { fire(): void } {
  const listeners: Array<() => void> = []
  return {
    scrollTop: 0,
    scrollLeft: 0,
    addEventListener: (_type, listener) => listeners.push(listener),
    fire: () => listeners.forEach((listener) => listener()),
  }
}

describe('column scroll guard', () => {
  it('puts a scrolled box back at the top and reports which one moved', () => {
    const lines: string[] = []
    const guard = createColumnScrollGuard((line) => lines.push(line), () => 'textarea')
    const box = fakeBox()
    guard.watch([{ box, name: 'fl-panel' }])
    box.scrollTop = 145
    box.fire()
    expect(box.scrollTop).toBe(0)
    expect(lines).toEqual(['chat column scrolled: fl-panel by 145px down, 0px across — put back; focus: textarea'])
  })

  it('says nothing when the box is already at the top (its own reset fires a scroll)', () => {
    const lines: string[] = []
    const guard = createColumnScrollGuard((line) => lines.push(line))
    const box = fakeBox()
    guard.watch([{ box, name: 'div.body' }])
    box.fire()
    expect(lines).toEqual([])
  })

  it('watches a box once however often it is handed over', () => {
    const lines: string[] = []
    const guard = createColumnScrollGuard((line) => lines.push(line))
    const box = fakeBox()
    guard.watch([{ box, name: 'div.pane' }])
    guard.watch([{ box, name: 'div.pane' }])
    box.scrollTop = 10
    box.fire()
    expect(lines).toHaveLength(1)
  })

  it('keeps resetting after the report budget is spent, and stops reporting', () => {
    const lines: string[] = []
    const guard = createColumnScrollGuard((line) => lines.push(line))
    const box = fakeBox()
    guard.watch([{ box, name: 'div.body' }])
    for (let i = 0; i < MAX_COLUMN_SCROLL_REPORTS + 3; i++) {
      box.scrollTop = 50
      box.fire()
      expect(box.scrollTop).toBe(0)
    }
    expect(lines).toHaveLength(MAX_COLUMN_SCROLL_REPORTS)
  })
})
