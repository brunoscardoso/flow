import {
  assignSide,
  buildSplitPlan,
  DEFAULT_PANEL_LAYOUT,
  effectivePanels,
  enforceNonEmpty,
  isMovablePanelId,
  moveFocused,
  normalizePanelLayout,
  rendersSomething,
  resetLayout,
  setFocusMode,
  toggleEditor,
  togglePanel,
  type MovablePanelId,
  type PanelLayout,
} from './panel-layout'

/** Convenience: build a layout from scratch for edge-case tests. */
function make(overrides: Partial<PanelLayout> = {}): PanelLayout {
  return { ...resetLayout(), ...overrides }
}

function sideOf(layout: PanelLayout, id: MovablePanelId): 'left' | 'right' {
  const panel = layout.panels.find((p) => p.id === id)
  if (panel === undefined) throw new Error(`missing panel ${id}`)
  return panel.side
}

describe('DEFAULT_PANEL_LAYOUT (#580)', () => {
  it("mirrors today's arrangement: conversation left/0 (threads is in the activity sidebar)", () => {
    expect(DEFAULT_PANEL_LAYOUT).toEqual({
      panels: [
        { id: 'conversation', side: 'left', order: 0, visible: true },
      ],
      editorVisible: true,
      focusMode: false,
    })
  })

  it('isMovablePanelId recognizes conversation and rejects others', () => {
    expect(isMovablePanelId('conversation')).toBe(true)
    expect(isMovablePanelId('threads')).toBe(false)
    expect(isMovablePanelId('files-git')).toBe(false)
    expect(isMovablePanelId('editor')).toBe(false)
    expect(isMovablePanelId(42)).toBe(false)
  })
})

describe('reducers never mutate their input', () => {
  it('assignSide / togglePanel / toggleEditor / setFocusMode return new objects', () => {
    const base = resetLayout()
    const snapshot = JSON.stringify(base)
    assignSide(base, 'conversation', 'right')
    togglePanel(base, 'conversation')
    toggleEditor(base)
    setFocusMode(base, true)
    moveFocused(base, 'conversation', 'left')
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})

describe('assignSide', () => {
  it('moves a panel to the target side, appended to the end', () => {
    // conversation starts left/0; move it right → it lands at right/0.
    const next = assignSide(resetLayout(), 'conversation', 'right')
    expect(sideOf(next, 'conversation')).toBe('right')
    const plan = buildSplitPlan(next)
    expect(plan.left).toEqual([])
    expect(plan.right).toEqual(['conversation'])
  })

  it('compacts orders on both sides (0..n)', () => {
    const next = assignSide(resetLayout(), 'conversation', 'right')
    const rightOrders = next.panels
      .filter((p) => p.side === 'right')
      .map((p) => p.order)
      .sort((a, b) => a - b)
    expect(rightOrders).toEqual([0])
  })

  it('is a faithful no-op clone for an unknown id (type-guarded at call sites)', () => {
    const base = resetLayout()
    const next = assignSide(base, 'nope' as MovablePanelId, 'left')
    expect(next).toEqual(base)
    expect(next).not.toBe(base)
  })
})

describe('moveFocused', () => {
  it("flips a panel's side to the given direction", () => {
    const right = moveFocused(resetLayout(), 'conversation', 'right')
    expect(sideOf(right, 'conversation')).toBe('right')
    const left = moveFocused(right, 'conversation', 'left')
    expect(sideOf(left, 'conversation')).toBe('left')
  })
})

describe('togglePanel', () => {
  it("flips a panel's own visibility", () => {
    const hidden = togglePanel(resetLayout(), 'conversation')
    expect(hidden.panels.find((p) => p.id === 'conversation')?.visible).toBe(false)
    const shown = togglePanel(hidden, 'conversation')
    expect(shown.panels.find((p) => p.id === 'conversation')?.visible).toBe(true)
  })
})

describe('toggleEditor', () => {
  it('flips editor visibility while other panels are visible', () => {
    const noEditor = toggleEditor(resetLayout())
    expect(noEditor.editorVisible).toBe(false)
    expect(toggleEditor(noEditor).editorVisible).toBe(true)
  })
})

describe('focus mode — the !focusMode overlay', () => {
  it('effectivePanels hides ALL panels when focus mode is on, without touching visible flags', () => {
    const focused = setFocusMode(resetLayout(), true)
    expect(focused.focusMode).toBe(true)
    expect(focused.panels.every((p) => p.visible)).toBe(true)
    expect(effectivePanels(focused)).toEqual([])
  })

  it('restores each panel exactly when focus mode turns off (no saved/restored flags)', () => {
    // Hide conversation, then focus on, then focus off — conversation stays hidden.
    const withHidden = togglePanel(resetLayout(), 'conversation')
    const off = setFocusMode(setFocusMode(withHidden, true), false)
    expect(off.focusMode).toBe(false)
    const shown = effectivePanels(off).map((p) => p.id)
    expect(shown).not.toContain('conversation')
  })
})

describe('effectivePanels ordering', () => {
  it('returns visible panels grouped and ordered deterministically', () => {
    const ids = effectivePanels(resetLayout()).map((p) => p.id)
    expect(ids).toEqual(['conversation'])
  })

  it('omits an individually-hidden panel', () => {
    const hidden = togglePanel(resetLayout(), 'conversation')
    expect(effectivePanels(hidden).map((p) => p.id)).toEqual([])
  })
})

describe('resetLayout', () => {
  it('returns the default arrangement as a fresh deep clone', () => {
    const reset = resetLayout()
    expect(reset).toEqual(DEFAULT_PANEL_LAYOUT)
    expect(reset).not.toBe(DEFAULT_PANEL_LAYOUT)
    expect(reset.panels).not.toBe(DEFAULT_PANEL_LAYOUT.panels)
  })
})

describe('non-empty invariant (NFR2 / R5) — never a blank shell', () => {
  it('forces the editor back on when hiding it would leave nothing rendered', () => {
    let layout = resetLayout()
    layout = togglePanel(layout, 'conversation')
    expect(effectivePanels(layout)).toEqual([])
    const blanked = toggleEditor(layout)
    expect(blanked.editorVisible).toBe(true)
  })

  it('forces the editor on when focus mode + hidden editor would blank the shell', () => {
    const noEditor = toggleEditor(resetLayout())
    expect(noEditor.editorVisible).toBe(false)
    const focused = setFocusMode(noEditor, true)
    expect(focused.editorVisible).toBe(true)
  })

  it('does NOT force the editor when at least one panel still renders', () => {
    const noEditor = toggleEditor(resetLayout())
    expect(noEditor.editorVisible).toBe(false)
    expect(effectivePanels(noEditor).length).toBeGreaterThan(0)
  })

  it('enforceNonEmpty is idempotent on a layout that already renders', () => {
    const base = resetLayout()
    expect(enforceNonEmpty(base)).toBe(base)
  })
})

describe('buildSplitPlan', () => {
  it('produces [left · editor · right] from the default layout', () => {
    expect(buildSplitPlan(resetLayout())).toEqual({
      left: ['conversation'],
      center: 'editor',
      right: [],
    })
  })

  it('orders panels within a side by order', () => {
    const next = assignSide(resetLayout(), 'conversation', 'right')
    expect(buildSplitPlan(next)).toEqual({
      left: [],
      center: 'editor',
      right: ['conversation'],
    })
  })

  it('center is null when the editor is hidden', () => {
    const noEditor = toggleEditor(resetLayout())
    expect(buildSplitPlan(noEditor).center).toBeNull()
  })

  it('focus mode empties both laterals, editor remains the center', () => {
    const focused = setFocusMode(resetLayout(), true)
    expect(buildSplitPlan(focused)).toEqual({ left: [], center: 'editor', right: [] })
  })
})

describe('normalizePanelLayout (fail-soft)', () => {
  it('defaults a non-object / null / missing-panels candidate', () => {
    for (const bad of [null, 'x', 42, undefined, {}, { panels: 'nope' }]) {
      expect(normalizePanelLayout(bad)).toEqual(DEFAULT_PANEL_LAYOUT)
    }
  })

  it('falls back to default when the conversation panel is missing', () => {
    expect(
      normalizePanelLayout({
        panels: [],
        editorVisible: true,
        focusMode: false,
      }),
    ).toEqual(DEFAULT_PANEL_LAYOUT)
  })

  it('drops stale threads panel from pre-refactor persisted layouts', () => {
    // Old layout had threads as a MovablePanelId — normalizePanelLayout now ignores it.
    const result = normalizePanelLayout({
      panels: [
        { id: 'threads', side: 'left', order: 0, visible: true },
        { id: 'conversation', side: 'left', order: 1, visible: true },
      ],
      editorVisible: true,
      focusMode: false,
    })
    // threads is stripped; conversation is kept and compacted.
    expect(result.panels.map((p) => p.id)).toEqual(['conversation'])
    expect(result.panels[0]?.order).toBe(0)
  })

  it('preserves a fully-valid candidate and compacts orders', () => {
    const result = normalizePanelLayout({
      panels: [
        { id: 'conversation', side: 'right', order: 9, visible: false },
      ],
      editorVisible: false,
      focusMode: false,
    })
    expect(result.editorVisible).toBe(true) // non-empty: conversation hidden + editor hidden → editor forced on
    expect(result.focusMode).toBe(false)
    expect(sideOf(result, 'conversation')).toBe('right')
    const orders = result.panels.map((p) => p.order)
    expect(orders).toEqual([0])
  })

  it('never restores a persisted focusMode — a transient overlay is always dropped to off (#616)', () => {
    const result = normalizePanelLayout({
      panels: make().panels,
      editorVisible: true,
      focusMode: true,
    })
    expect(result.focusMode).toBe(false)
  })

  it('applies the non-empty invariant when the editor is hidden and every panel is invisible', () => {
    const result = normalizePanelLayout({
      panels: [
        { id: 'conversation', side: 'left', order: 0, visible: false },
      ],
      editorVisible: false,
      focusMode: false,
    })
    expect(result.editorVisible).toBe(true)
  })
})

describe('enforceNonEmpty sees surfaces outside this model (#1351)', () => {
  // The guard's test was `editorVisible || effectivePanels().length > 0`, and
  // effectivePanels() only knows the movable panels. The activity sidebar
  // renders (306px, open by default) but is driven by RailItem in
  // sidetab-state, deliberately outside this model — so the guard fired in
  // states where the shell would obviously not be blank.
  const emptyLayout = (): PanelLayout => ({
    panels: [{ id: 'conversation', side: 'left', order: 0, visible: false }],
    editorVisible: false,
    focusMode: false,
  })

  it('still forces the editor back when NOTHING would render', () => {
    expect(enforceNonEmpty(emptyLayout()).editorVisible).toBe(true)
  })

  it('leaves the editor hidden when the sidebar is rendering', () => {
    // ⌘⌥D was a dead key here: the editor snapped straight back on.
    const kept = enforceNonEmpty({ ...emptyLayout(), otherSurfacesVisible: true })
    expect(kept.editorVisible).toBe(false)
  })

  it('does not count the sidebar when it is itself hidden', () => {
    const forced = enforceNonEmpty({ ...emptyLayout(), otherSurfacesVisible: false })
    expect(forced.editorVisible).toBe(true)
  })

  it('keeps the old behaviour for a layout that never says (older persisted state)', () => {
    const layout = emptyLayout()
    expect('otherSurfacesVisible' in layout).toBe(false)
    expect(enforceNonEmpty(layout).editorVisible).toBe(true)
  })
})

// #1538 — the guard trusted `editorVisible`, which is a REQUEST. #675 collapses
// an editor stack with no tab and no docked terminal, so a layout could carry
// `editorVisible: true`, satisfy the guard, and paint a blank rectangle. Three
// ordinary put-aways (chat, terminal, sidebar) on a zero-tab window reached
// exactly that state, and it was persisted and relaunched into.
describe('enforceNonEmpty sees whether the editor actually paints (#1538)', () => {
  const putAway = (): PanelLayout => ({
    panels: [{ id: 'conversation', side: 'left', order: 0, visible: false }],
    editorVisible: true,
    focusMode: false,
    otherSurfacesVisible: false,
  })

  it('reports nothing rendering when the visible editor has no content', () => {
    // THE BUG, stated: every flag the guard used to read says "fine".
    expect(rendersSomething({ ...putAway(), editorHasContent: false })).toBe(false)
  })

  it('reports the editor as rendering once it has a tab or a docked terminal', () => {
    expect(rendersSomething({ ...putAway(), editorHasContent: true })).toBe(true)
  })

  it('still counts an open panel even when the editor paints nothing', () => {
    const withChat: PanelLayout = {
      ...putAway(),
      panels: [{ id: 'conversation', side: 'left', order: 0, visible: true }],
      editorHasContent: false,
    }
    expect(rendersSomething(withChat)).toBe(true)
  })

  it('still counts the activity sidebar even when the editor paints nothing', () => {
    expect(
      rendersSomething({ ...putAway(), otherSurfacesVisible: true, editorHasContent: false }),
    ).toBe(true)
  })

  it('assumes the editor paints when a layout never says (pre-#1538 persisted state)', () => {
    const layout = putAway()
    expect('editorHasContent' in layout).toBe(false)
    expect(rendersSomething(layout)).toBe(true)
  })

  it('leaves the layout alone — the model cannot conjure a tab', () => {
    // The remedy is the shell's watermark, not a flag flip: editorVisible is
    // ALREADY true here, so a guard that only forces it has nothing to give.
    const blank = { ...putAway(), editorHasContent: false }
    expect(enforceNonEmpty(blank).editorVisible).toBe(true)
    expect(rendersSomething(enforceNonEmpty(blank))).toBe(false)
  })
})

// Both optional flags were listed field-by-field in cloneLayout and simply not
// listed, so every reducer handed enforceNonEmpty a layout that had forgotten
// what the shell told it — reviving #1351's symptom B one call before
// applyLayout re-supplied the flag it had already acted on.
describe('reducers preserve the flags the shell supplies (#1351/#1538)', () => {
  const hiddenChat: PanelLayout = {
    panels: [{ id: 'conversation', side: 'left', order: 0, visible: true }],
    editorVisible: true,
    focusMode: false,
    otherSurfacesVisible: true,
    editorHasContent: false,
  }

  it('togglePanel keeps otherSurfacesVisible, so hiding the chat does not re-open the editor', () => {
    const next = togglePanel({ ...hiddenChat, editorVisible: false }, 'conversation')
    expect(next.otherSurfacesVisible).toBe(true)
    expect(next.editorVisible).toBe(false)
  })

  it('assignSide keeps both flags', () => {
    const next = assignSide(hiddenChat, 'conversation', 'right')
    expect(next.otherSurfacesVisible).toBe(true)
    expect(next.editorHasContent).toBe(false)
  })

  it('leaves both undefined when the caller never set them', () => {
    const next = togglePanel(DEFAULT_PANEL_LAYOUT, 'conversation')
    expect('otherSurfacesVisible' in next).toBe(false)
    expect('editorHasContent' in next).toBe(false)
  })
})
