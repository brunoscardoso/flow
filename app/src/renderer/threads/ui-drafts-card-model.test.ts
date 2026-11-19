import {
  deriveUiDraftsState,
  isCanvasComplete,
  UiDraftsAsks,
  uiDraftsCanvasFor,
  uiDraftsWritingText,
  UI_DRAFTS_WRITING_WINDOW_MS,
} from './ui-drafts-card-model'
import {
  buildArtifactModel,
  artifactRowActions,
  uiDraftsCommandFor,
  artifactCommandFor,
} from './artifact-card-model'

const NOW = 1_800_000_000_000
const complete = { screenCount: 3, screensWritten: 3, updatedAt: NOW - 1000 }

describe('uiDraftsCommandFor', () => {
  it('names the discovery in the same mention spelling as the artifact command', () => {
    const path = 'flow/discovery/discovery_user-auth_v1.md'
    expect(uiDraftsCommandFor(path)).toBe(artifactCommandFor(path).replace('/artifact', '/ui-draft'))
    expect(uiDraftsCommandFor(path)).toBe('/ui-draft @flow/discovery/discovery_user-auth_v1.md')
  })
  it('quotes a path with a space like the artifact command does', () => {
    const path = 'flow/discovery/discovery_my feature_v1.md'
    expect(uiDraftsCommandFor(path)).toBe(artifactCommandFor(path).replace('/artifact', '/ui-draft'))
  })
})

describe('uiDraftsCanvasFor', () => {
  it('is the lowercased feature slug, discoveries only', () => {
    expect(uiDraftsCanvasFor('discovery', 'ui_drafts')).toBe('ui-drafts')
    expect(uiDraftsCanvasFor('discovery', 'User Auth')).toBe('user-auth')
    expect(uiDraftsCanvasFor('plan', 'ui_drafts')).toBeNull()
    expect(uiDraftsCanvasFor('discovery', null)).toBeNull()
    expect(uiDraftsCanvasFor('discovery', '___')).toBeNull()
  })
  it('rides on the card model for a discovery', () => {
    const model = buildArtifactModel(
      { kind: 'discovery', path: 'flow/discovery/discovery_ui_drafts_v1.md', name: 'discovery_ui_drafts_v1.md', mtime: NOW } as never,
      null,
      undefined,
      NOW,
    )
    expect(model.uiDraftsCanvas).toBe('ui-drafts')
  })
})

describe('deriveUiDraftsState', () => {
  it('offers to generate when no canvas exists', () => {
    expect(deriveUiDraftsState(undefined, null, NOW)).toEqual({ state: 'generate' })
  })
  it('counts the screens written while the layout is fresh', () => {
    const info = { screenCount: 5, screensWritten: 3, updatedAt: NOW - 5000 }
    expect(deriveUiDraftsState(info, null, NOW)).toEqual({ state: 'writing', written: 3, total: 5 })
    expect(uiDraftsWritingText({ state: 'writing', written: 3, total: 5 })).toBe('Writing UI drafts… 3 of 5 screens')
  })
  it('is open when every screen exists', () => {
    expect(deriveUiDraftsState(complete, null, NOW)).toEqual({ state: 'open' })
    expect(isCanvasComplete(complete)).toBe(true)
  })
  it('keeps what an interrupted run wrote reachable once the window passes', () => {
    const stale = { screenCount: 5, screensWritten: 2, updatedAt: NOW - UI_DRAFTS_WRITING_WINDOW_MS - 1 }
    expect(deriveUiDraftsState(stale, null, NOW)).toEqual({ state: 'open' })
    expect(deriveUiDraftsState({ ...stale, screensWritten: 0 }, null, NOW)).toEqual({ state: 'generate' })
  })
  it('shows writing right after a press, before the layout exists, then gives up', () => {
    expect(deriveUiDraftsState(undefined, NOW - 1000, NOW)).toEqual({ state: 'writing', written: 0, total: 0 })
    expect(uiDraftsWritingText({ state: 'writing', written: 0, total: 0 })).toBe('Writing UI drafts…')
    expect(deriveUiDraftsState(undefined, NOW - UI_DRAFTS_WRITING_WINDOW_MS - 1, NOW)).toEqual({ state: 'generate' })
  })
  it('treats a layout that cannot be read as no canvas yet', () => {
    expect(deriveUiDraftsState({ screenCount: 0, problem: 'The layout is not valid JSON.' }, null, NOW)).toEqual({ state: 'generate' })
  })
  it('says one screen in the singular', () => {
    expect(uiDraftsWritingText({ state: 'writing', written: 0, total: 1 })).toBe('Writing UI drafts… 0 of 1 screen')
  })
})

describe('the action row', () => {
  const base = { selected: 'discovery', holds: ['discovery'], openDoc: true, artifact: true, notes: null } as const
  it('adds the UI drafts door after the artifact only when asked', () => {
    expect(artifactRowActions({ ...base })).toEqual(['create-plan', 'open-doc', 'artifact'])
    expect(artifactRowActions({ ...base, uiDrafts: true })).toEqual(['create-plan', 'open-doc', 'artifact', 'ui-drafts'])
  })
  it('never adds it to a plan row', () => {
    expect(artifactRowActions({ ...base, selected: 'plan', uiDrafts: true })).not.toContain('ui-drafts')
  })
})

describe('UiDraftsAsks — a finished canvas opens once, for the thread that asked', () => {
  const key = '/repo\u0000checkout'
  it('opens a complete canvas once after the ask', () => {
    const asks = new UiDraftsAsks()
    asks.record('t1', key, NOW)
    expect(asks.pending('t1', key)).toBe(true)
    expect(asks.takeOpen('t1', key, complete)).toBe(true)
    expect(asks.takeOpen('t1', key, complete)).toBe(false)
    expect(asks.pending('t1', key)).toBe(false)
  })
  it('waits while the canvas is incomplete', () => {
    const asks = new UiDraftsAsks()
    asks.record('t1', key, NOW)
    expect(asks.takeOpen('t1', key, { screenCount: 3, screensWritten: 2 })).toBe(false)
    expect(asks.takeOpen('t1', key, undefined)).toBe(false)
    expect(asks.pending('t1', key)).toBe(true)
  })
  it('never opens for a thread that did not ask, nor for another canvas', () => {
    const asks = new UiDraftsAsks()
    asks.record('t1', key, NOW)
    expect(asks.takeOpen('t2', key, complete)).toBe(false)
    expect(asks.takeOpen('t1', '/repo\u0000other', complete)).toBe(false)
    expect(asks.takeOpen(null, key, complete)).toBe(false)
  })
  it('opens again after a second ask', () => {
    const asks = new UiDraftsAsks()
    asks.record('t1', key, NOW)
    asks.takeOpen('t1', key, complete)
    asks.record('t1', key, NOW + 1)
    expect(asks.takeOpen('t1', key, complete)).toBe(true)
  })
  it('remembers when it asked', () => {
    const asks = new UiDraftsAsks()
    expect(asks.askedAt('t1', key)).toBeNull()
    asks.record('t1', key, NOW)
    expect(asks.askedAt('t1', key)).toBe(NOW)
  })
})
