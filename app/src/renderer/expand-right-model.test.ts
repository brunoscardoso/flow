import {
  DEFAULT_PANEL_LAYOUT,
  buildSplitPlan,
  normalizePanelLayout,
  toggleEditor,
  togglePanel,
  type PanelLayout,
} from './panel-layout'
import { collapseRightArea } from './right-area-model'
import {
  chatOnScreen,
  enterRightExpanded,
  leaveRightExpanded,
  revealChat,
  rightExpandedIcon,
  rightExpandedLabel,
  rightExpandedShown,
  shouldLeaveExpandedOnEscape,
  toggleRightExpanded,
  type ExpandedEscapeContext,
} from './expand-right-model'

const layout = (overrides: Partial<PanelLayout> = {}): PanelLayout => ({
  ...DEFAULT_PANEL_LAYOUT,
  panels: DEFAULT_PANEL_LAYOUT.panels.map((panel) => ({ ...panel })),
  ...overrides,
})
const chatOwnVisible = (l: PanelLayout): boolean =>
  l.panels.find((panel) => panel.id === 'conversation')?.visible === true

describe('one press steps the chat aside, the next brings it back', () => {
  it('normal → expanded: only the chat leaves, the editor stays', () => {
    const start = layout()
    expect(buildSplitPlan(start)).toEqual({ left: ['conversation'], center: 'editor', right: [] })
    const expanded = toggleRightExpanded(start)
    expect(rightExpandedShown(expanded)).toBe(true)
    expect(chatOnScreen(expanded)).toBe(false)
    expect(buildSplitPlan(expanded)).toEqual({ left: [], center: 'editor', right: [] })
    // The chat's own visibility is untouched — the flag is an overlay.
    expect(chatOwnVisible(expanded)).toBe(true)
  })

  it('expanded → normal restores the exact previous arrangement', () => {
    const start = layout()
    const back = toggleRightExpanded(toggleRightExpanded(start))
    expect(rightExpandedShown(back)).toBe(false)
    expect(buildSplitPlan(back)).toEqual(buildSplitPlan(start))
    expect(back.panels).toEqual(start.panels)
    expect(back.editorVisible).toBe(true)
  })

  it('does not mutate its input', () => {
    const start = layout()
    const snapshot = JSON.stringify(start)
    toggleRightExpanded(start)
    leaveRightExpanded(enterRightExpanded(start))
    expect(JSON.stringify(start)).toBe(snapshot)
  })

  it('keeps a chat that sits on the right side where it was', () => {
    const start = layout({ panels: [{ id: 'conversation', side: 'right', order: 0, visible: true }] })
    const back = toggleRightExpanded(toggleRightExpanded(start))
    expect(back.panels).toEqual(start.panels)
  })

  it('is inert under focus mode', () => {
    const focused = layout({ focusMode: true })
    expect(toggleRightExpanded(focused)).toBe(focused)
    expect(rightExpandedShown(layout({ focusMode: true, rightExpanded: true }))).toBe(false)
  })
})

describe('the right side hidden', () => {
  it('pressing expand shows it first, then expands', () => {
    const hidden = layout({ editorVisible: false })
    const expanded = toggleRightExpanded(hidden)
    expect(expanded.editorVisible).toBe(true)
    expect(rightExpandedShown(expanded)).toBe(true)
    expect(buildSplitPlan(expanded).center).toBe('editor')
  })

  it('hiding the right side while expanded leaves the mode and brings the chat back (toggle)', () => {
    const expanded = enterRightExpanded(layout())
    const hidden = collapseRightArea(expanded, { rendered: true, otherSurfacesVisible: true })
    expect(hidden.editorVisible).toBe(false)
    expect(hidden.rightExpanded).toBe(false)
    expect(chatOnScreen(hidden)).toBe(true)
    expect(buildSplitPlan(hidden).left).toEqual(['conversation'])
  })

  it('hiding the editor (⌘⌥D) while expanded never leaves an empty middle', () => {
    const expanded = enterRightExpanded(layout())
    const hidden = toggleEditor({ ...expanded, otherSurfacesVisible: true })
    expect(hidden.rightExpanded).toBe(false)
    expect(chatOnScreen(hidden)).toBe(true)
  })

  it('an expanded flag without a shown editor never hides the chat', () => {
    const odd = layout({ editorVisible: false, rightExpanded: true })
    expect(chatOnScreen(odd)).toBe(true)
    expect(buildSplitPlan(odd).left).toEqual(['conversation'])
  })
})

describe('anything that needs the chat brings it back', () => {
  it('a chat toggle while expanded shows the chat, never flips a hidden flag', () => {
    const expanded = enterRightExpanded(layout())
    const toggled = togglePanel(expanded, 'conversation')
    expect(chatOnScreen(toggled)).toBe(true)
    expect(toggled.rightExpanded).toBe(false)
  })

  it('reveal shows it from expanded, and from a chat put away on its own', () => {
    expect(chatOnScreen(revealChat(enterRightExpanded(layout())))).toBe(true)
    const putAway = togglePanel(layout(), 'conversation')
    expect(chatOnScreen(revealChat(putAway))).toBe(true)
  })

  it('reveal is a no-op when the chat is already on screen', () => {
    const start = layout()
    expect(revealChat(start)).toBe(start)
  })

  it('leaving with the chat also put away on its own brings it back ("Show the chat")', () => {
    const putAway = togglePanel(layout(), 'conversation')
    const expanded = enterRightExpanded(putAway)
    expect(chatOnScreen(leaveRightExpanded(expanded))).toBe(true)
  })
})

describe('remembered with the layout', () => {
  it('survives a normalize (the persisted round trip)', () => {
    const expanded = enterRightExpanded(layout())
    const restored = normalizePanelLayout(JSON.parse(JSON.stringify(expanded)))
    expect(rightExpandedShown(restored)).toBe(true)
  })

  it('an older layout without the field reads as not expanded', () => {
    const restored = normalizePanelLayout(JSON.parse(JSON.stringify(layout())))
    expect(restored.rightExpanded).toBeUndefined()
    expect(rightExpandedShown(restored)).toBe(false)
  })

  it('a corrupt value, or one beside a hidden editor, is dropped', () => {
    expect(normalizePanelLayout({ ...layout(), rightExpanded: 'yes' }).rightExpanded).toBeUndefined()
    expect(
      normalizePanelLayout({ ...layout(), editorVisible: false, rightExpanded: true }).rightExpanded,
    ).toBeUndefined()
  })
})

describe('the button says what pressing it does', () => {
  it('labels and glyphs', () => {
    expect(rightExpandedLabel(false)).toBe('Expand the right side')
    expect(rightExpandedLabel(true)).toBe('Show the chat')
    expect(rightExpandedIcon(false)).toBe('expand-diagonal')
    expect(rightExpandedIcon(true)).toBe('collapse-diagonal')
  })
})

describe('Escape leaves only when nothing nearer wants it', () => {
  const quiet: ExpandedEscapeContext = {
    expanded: true,
    handled: false,
    modalOpen: false,
    popupOpen: false,
    editorWidgetOpen: false,
    focusInEditable: false,
  }
  it('leaves when expanded and nothing else claims the key', () => {
    expect(shouldLeaveExpandedOnEscape(quiet)).toBe(true)
  })
  it('does nothing when not expanded', () => {
    expect(shouldLeaveExpandedOnEscape({ ...quiet, expanded: false })).toBe(false)
  })
  it.each([
    ['handled', { handled: true }],
    ['a modal', { modalOpen: true }],
    ['a menu or popover', { popupOpen: true }],
    ['a Monaco widget', { editorWidgetOpen: true }],
    ['focus in a terminal, editor or field', { focusInEditable: true }],
  ] as const)('yields to %s', (_name, override) => {
    expect(shouldLeaveExpandedOnEscape({ ...quiet, ...override })).toBe(false)
  })
})
