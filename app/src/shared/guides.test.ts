import {
  GUIDE_IDS,
  GUIDE_TOURS,
  applyGuidesUpdate,
  defaultGuidesState,
  guidesFinished,
  nextGuideAction,
  parseGuidesState,
  pickGuide,
  placeCard,
  type GuideMoment,
  type GuidesState,
} from './guides'

const fresh = (over: Partial<GuidesState> = {}): GuidesState => ({ ...defaultGuidesState(true), ...over })
const moment = (over: Partial<GuideMoment> = {}): GuideMoment => ({
  state: fresh({ overviewSeen: true }),
  busy: false,
  dialogOpen: false,
  inDialog: [],
  hasProject: true,
  onScreen: [],
  requested: null,
  ...over,
})

describe('the stored state', () => {
  it('reads nothing as the default, with tips as the caller says', () => {
    expect(parseGuidesState(null, true)).toEqual({ enabled: true, overviewSeen: false, seen: [] })
    expect(parseGuidesState(undefined, false)).toEqual({ enabled: false, overviewSeen: false, seen: [] })
    expect(parseGuidesState('not json', true).enabled).toBe(true)
  })

  it('keeps a stored answer over the default, and drops tours that no longer exist', () => {
    const raw = JSON.stringify({ enabled: false, overviewSeen: true, seen: ['tasks', 'gone', 'tasks', 7] })
    expect(parseGuidesState(raw, true)).toEqual({ enabled: false, overviewSeen: true, seen: ['tasks'] })
  })

  it('applies a partial update without touching the rest, or the input', () => {
    const before = fresh({ seen: ['tasks'] })
    const after = applyGuidesUpdate(before, { seen: 'blueprint' })
    expect(after).toEqual({ enabled: true, overviewSeen: false, seen: ['tasks', 'blueprint'] })
    expect(before.seen).toEqual(['tasks'])
    expect(applyGuidesUpdate(after, { seen: 'tasks' }).seen).toEqual(['tasks', 'blueprint'])
    expect(applyGuidesUpdate(after, { unseen: 'tasks' }).seen).toEqual(['blueprint'])
    expect(applyGuidesUpdate(after, { enabled: false }).enabled).toBe(false)
    expect(applyGuidesUpdate(after, { seen: 'nope' as never }).seen).toEqual(['tasks', 'blueprint'])
  })

  it('reset forgets the overview and every tour, and keeps the switch', () => {
    const state = fresh({ enabled: false, overviewSeen: true, seen: ['tasks'] })
    expect(applyGuidesUpdate(state, { resetAll: true })).toEqual({ enabled: false, overviewSeen: false, seen: [] })
  })
})

describe('what to show', () => {
  it('shows the overview first, once a project is open', () => {
    expect(nextGuideAction(moment({ state: fresh(), onScreen: ['tasks'] }))).toEqual({ kind: 'overview' })
    expect(nextGuideAction(moment({ state: fresh(), hasProject: false }))).toEqual({ kind: 'none' })
  })

  it('starts the tour of a screen that is on screen and not seen', () => {
    expect(nextGuideAction(moment({ onScreen: ['tasks'] }))).toEqual({ kind: 'tour', id: 'tasks' })
    const seen = fresh({ overviewSeen: true, seen: ['tasks'] })
    expect(nextGuideAction(moment({ state: seen, onScreen: ['tasks'] }))).toEqual({ kind: 'none' })
  })

  it('takes the first in guide order when two screens are up', () => {
    expect(nextGuideAction(moment({ onScreen: ['blueprint', 'threads'] }))).toEqual({ kind: 'tour', id: 'threads' })
  })

  it('never starts over a dialog or another tour', () => {
    expect(nextGuideAction(moment({ busy: true, onScreen: ['tasks'] }))).toEqual({ kind: 'none' })
    expect(nextGuideAction(moment({ busy: true, state: fresh() }))).toEqual({ kind: 'none' })
  })

  it('over a dialog, starts only a tour about that dialog', () => {
    const open = { dialogOpen: true, onScreen: ['blueprint', 'ask'] as const }
    expect(nextGuideAction(moment({ ...open, inDialog: [] }))).toEqual({ kind: 'none' })
    expect(nextGuideAction(moment({ ...open, inDialog: ['ask'] }))).toEqual({ kind: 'tour', id: 'ask' })
    // The overview never opens over a dialog.
    expect(nextGuideAction(moment({ state: fresh(), dialogOpen: true, inDialog: ['ask'], onScreen: ['ask'] }))).toEqual({
      kind: 'none',
    })
    // A replay of a screen behind the dialog waits for it to close.
    expect(nextGuideAction(moment({ dialogOpen: true, requested: 'tasks', onScreen: ['tasks'] }))).toEqual({ kind: 'none' })
  })

  it('shows nothing on its own with tips off', () => {
    const off = fresh({ enabled: false })
    expect(nextGuideAction(moment({ state: off, onScreen: ['tasks'] }))).toEqual({ kind: 'none' })
  })

  it('runs a tour a person asked for, with tips off and over a seen mark, once its screen is up', () => {
    const off = fresh({ enabled: false, seen: ['tasks'] })
    expect(nextGuideAction(moment({ state: off, requested: 'tasks', onScreen: [] }))).toEqual({ kind: 'none' })
    expect(nextGuideAction(moment({ state: off, requested: 'tasks', onScreen: ['tasks'] }))).toEqual({
      kind: 'tour',
      id: 'tasks',
    })
  })

  it('a request waits for its own screen, not another unseen one', () => {
    expect(nextGuideAction(moment({ requested: 'blueprint', onScreen: ['tasks'] }))).toEqual({ kind: 'none' })
  })

  it('is finished with tips off, or once everything has run', () => {
    expect(guidesFinished(fresh({ enabled: false }))).toBe(true)
    expect(guidesFinished(fresh({ overviewSeen: true, seen: [...GUIDE_IDS] }))).toBe(true)
    expect(guidesFinished(fresh({ overviewSeen: true, seen: ['tasks'] }))).toBe(false)
  })
})

describe('the tours themselves', () => {
  it('has one tour per id, each with a trigger and at least one step', () => {
    expect(GUIDE_TOURS.map((t) => t.id)).toEqual([...GUIDE_IDS])
    for (const tour of GUIDE_TOURS) {
      expect(tour.trigger.length).toBeGreaterThan(0)
      expect(tour.steps.length).toBeGreaterThan(0)
      expect(tour.steps.length).toBeLessThanOrEqual(4)
    }
  })

  it('never puts a command line, a path or a config key in front of a person', () => {
    const text = GUIDE_TOURS.flatMap((t) => [t.name, t.summary, ...t.steps.flatMap((s) => [s.title, s.body])])
    for (const line of text) {
      expect(line).not.toMatch(/planflow|npm |\.md\b|flow\/|\.flowconfig|`/)
    }
  })
})

describe('placing the card', () => {
  const view = { width: 1280, height: 800 }
  const card = { width: 340, height: 180 }

  it('goes right of the anchor when it fits', () => {
    const p = placeCard({ left: 100, top: 100, width: 200, height: 40 }, card, view)
    expect(p).toEqual({ side: 'right', left: 314, top: 100 })
  })

  it('goes left when the right is full, then below, then above', () => {
    expect(placeCard({ left: 900, top: 100, width: 300, height: 40 }, card, view).side).toBe('left')
    expect(placeCard({ left: 100, top: 100, width: 1100, height: 40 }, card, view).side).toBe('below')
    expect(placeCard({ left: 100, top: 560, width: 1100, height: 200 }, card, view).side).toBe('above')
  })

  it('centres over the window when it fits nowhere, or without an anchor', () => {
    expect(placeCard({ left: 0, top: 0, width: 1280, height: 800 }, card, view)).toEqual({ side: 'center', left: 470, top: 310 })
    expect(placeCard(null, card, view).side).toBe('center')
  })

  it('keeps the card inside the window', () => {
    const p = placeCard({ left: 100, top: 760, width: 100, height: 30 }, card, view)
    expect(p.side).toBe('right')
    expect(p.top + card.height).toBeLessThanOrEqual(view.height - 12)
  })
})

describe('which tour an (i) means', () => {
  it('takes the most specific tour whose screen is up', () => {
    const up = new Set(['diagram', 'blueprint'])
    expect(pickGuide(['block', 'diagram', 'blueprint'], (id) => up.has(id))).toBe('diagram')
  })

  it('falls back to the last one when nothing is up yet', () => {
    expect(pickGuide(['block', 'diagram', 'blueprint'], () => false)).toBe('blueprint')
    expect(pickGuide([], () => true)).toBeNull()
  })
})
