import { DEFAULT_PANEL_LAYOUT, normalizePanelLayout, togglePanel, type PanelLayout } from './panel-layout'
import {
  COLLAPSED_READING_COLUMN_PX,
  collapseRightArea,
  keepPaneFraction,
  expandRightArea,
  rightAreaShown,
  rightAreaToggleTitle,
  toggleRightArea,
} from './right-area-model'

const layout = (overrides: Partial<PanelLayout> = {}): PanelLayout => ({
  ...DEFAULT_PANEL_LAYOUT,
  panels: DEFAULT_PANEL_LAYOUT.panels.map((panel) => ({ ...panel })),
  ...overrides,
})
const ON_SCREEN = { rendered: true, otherSurfacesVisible: true }
const chatVisible = (l: PanelLayout): boolean =>
  l.panels.find((panel) => panel.id === 'conversation')?.visible === true

describe('the toggle reflects what is on screen', () => {
  it('is pressed when the editor area renders', () => {
    expect(rightAreaShown(layout(), ON_SCREEN)).toBe(true)
  })
  it('is not pressed when the area is put away', () => {
    expect(rightAreaShown(layout({ editorVisible: false }), { ...ON_SCREEN, rendered: false })).toBe(false)
  })
  it('is not pressed when the area was asked for but has nothing to paint (an empty, collapsed editor)', () => {
    expect(rightAreaShown(layout(), { ...ON_SCREEN, rendered: false })).toBe(false)
  })
  it('is not pressed under focus mode, where it is inert', () => {
    expect(rightAreaShown(layout({ focusMode: true }), ON_SCREEN)).toBe(false)
  })
})

describe('one press puts the area away, the next brings it back', () => {
  it('collapses to the conversation and back, nothing else moved', () => {
    const start = layout()
    const hidden = toggleRightArea(start, ON_SCREEN)
    expect(hidden.editorVisible).toBe(false)
    expect(chatVisible(hidden)).toBe(true)
    const back = toggleRightArea(hidden, { ...ON_SCREEN, rendered: false })
    expect(back.editorVisible).toBe(true)
    expect(back.panels).toEqual(start.panels)
  })

  it('never mutates the layout it was given', () => {
    const start = layout()
    toggleRightArea(start, ON_SCREEN)
    expect(start.editorVisible).toBe(true)
  })

  it('with the chat hidden but the sidebar open, the sidebar takes the width (#1351 left alone)', () => {
    const noChat = togglePanel(layout(), 'conversation')
    expect(chatVisible(noChat)).toBe(false) // the positive first
    const hidden = toggleRightArea(noChat, ON_SCREEN)
    expect(hidden.editorVisible).toBe(false)
    expect(chatVisible(hidden)).toBe(false)
  })

  it('is never a dead key: with nothing else on screen, the conversation comes back to take the width', () => {
    const noChat: PanelLayout = {
      ...layout(),
      panels: [{ id: 'conversation', side: 'left', order: 0, visible: false }],
    }
    const hidden = toggleRightArea(noChat, { rendered: true, otherSurfacesVisible: false })
    expect(hidden.editorVisible).toBe(false)
    expect(chatVisible(hidden)).toBe(true)
  })

  it('is inert under focus mode', () => {
    const focused = layout({ focusMode: true })
    expect(toggleRightArea(focused, ON_SCREEN)).toBe(focused)
  })
})

describe('anything that needs the area brings it back', () => {
  it('expand reveals a put-away area and leaves a shown one alone', () => {
    const hidden = collapseRightArea(layout(), ON_SCREEN)
    expect(expandRightArea(hidden).editorVisible).toBe(true)
    const shown = layout()
    expect(expandRightArea(shown)).toBe(shown)
  })
})

describe('the state survives a relaunch', () => {
  it('a put-away area normalizes back as put away (the chat stays to fill the window)', () => {
    const hidden = collapseRightArea(layout(), ON_SCREEN)
    const restored = normalizePanelLayout(JSON.parse(JSON.stringify(hidden)))
    expect(restored.editorVisible).toBe(false)
    expect(chatVisible(restored)).toBe(true)
  })
})

describe('the tooltip says what pressing does', () => {
  it('names the consequence and the shortcut, never a command', () => {
    expect(rightAreaToggleTitle(true)).toBe('Hide the editor area (⌘⌥B)')
    expect(rightAreaToggleTitle(false)).toBe('Show the editor area (⌘⌥B)')
  })
})

describe('the sidebar keeps its width when the area goes or comes back', () => {
  it('pins one pane and shares the rest in the others’ own proportions', () => {
    const next = keepPaneFraction([0.5, 0.5], 0, 0.2)
    expect(next[0]).toBeCloseTo(0.2)
    expect(next[1]).toBeCloseTo(0.8)
    const three = keepPaneFraction([0.22, 0.22, 0.56], 0, 0.3)
    expect(three[0]).toBeCloseTo(0.3)
    expect(three[1] / three[2]).toBeCloseTo(0.22 / 0.56)
    expect(three.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
  it('refuses what it cannot honour, unchanged', () => {
    expect(keepPaneFraction([0.5, 0.5], 0, 0)).toEqual([0.5, 0.5])
    expect(keepPaneFraction([0.5, 0.5], 0, 1)).toEqual([0.5, 0.5])
    expect(keepPaneFraction([0.5, 0.5], 2, 0.3)).toEqual([0.5, 0.5])
    expect(keepPaneFraction([1], 0, 0.3)).toEqual([1])
    expect(keepPaneFraction([0.5, 0.5], 0, Number.NaN)).toEqual([0.5, 0.5])
  })
})

describe('the reading column', () => {
  it('is a readable width, inside the asked-for 640–680px', () => {
    expect(COLLAPSED_READING_COLUMN_PX).toBeGreaterThanOrEqual(640)
    expect(COLLAPSED_READING_COLUMN_PX).toBeLessThanOrEqual(680)
  })
})
