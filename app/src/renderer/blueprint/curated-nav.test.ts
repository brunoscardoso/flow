// Tests for curated-view navigation.
//
// The rules that matter are both about not over-claiming. The trail ALWAYS
// includes the root, because a drilled view with no visible way back is the
// one-way door in a smaller shape. And an empty selection lights everything
// rather than blanking the diagram — "this phase touches none of these" is not
// "these do not exist".

import { curatedCrumbs, curatedLadder, litWire, phaseHighlight } from './curated-nav'
import type { CuratedLevel, CuratedView } from './curated-view'

const ROOT: CuratedLevel = {
  title: 'Chat, today',
  nodes: [
    { id: 'bff', kind: 'endpoint', title: 'BFF', delta: 'modify', phases: [1, 2] },
    { id: 'engine', kind: 'endpoint', title: 'Engine', delta: 'stable', phases: [2] },
    { id: 'db', kind: 'datastore', title: 'DB', delta: 'stable' },
  ],
  edges: [{ from: 'bff', to: 'engine', label: 'forward', delta: 'kept' }],
}

const VIEW: CuratedView = {
  feature: 'chats',
  provenance: 'plan:x',
  generatedAt: '2026-08-04',
  meta: { title: 'Chats' },
  views: {
    root: ROOT,
    bffdetail: { title: 'Inside the BFF', nodes: [], edges: [] },
    deeper: { title: 'Deeper still', nodes: [], edges: [] },
  },
}

describe('curatedCrumbs', () => {
  it('shows the root alone at the top level, marked current', () => {
    expect(curatedCrumbs(VIEW, [])).toEqual([{ id: 'root', title: 'Chat, today', current: true }])
  })

  it('ALWAYS keeps the root in the trail — there is always a way back', () => {
    const crumbs = curatedCrumbs(VIEW, ['bffdetail'])
    expect(crumbs[0].id).toBe('root')
    expect(crumbs[0].current).toBe(false)
    expect(crumbs[1]).toEqual({ id: 'bffdetail', title: 'Inside the BFF', current: true })
  })

  it('marks only the deepest level current', () => {
    const crumbs = curatedCrumbs(VIEW, ['bffdetail', 'deeper'])
    expect(crumbs.map((crumb) => crumb.current)).toEqual([false, false, true])
  })

  it('skips a level the artifact no longer has rather than showing a dead crumb', () => {
    expect(curatedCrumbs(VIEW, ['ghost']).map((crumb) => crumb.id)).toEqual(['root'])
  })

  it('is empty when there is no view', () => {
    expect(curatedCrumbs(null, [])).toEqual([])
  })
})

describe('curatedLadder', () => {
  it('lists the phases ascending, with how many components each touches', () => {
    expect(curatedLadder(ROOT)).toEqual([
      { phase: 1, count: 1 },
      { phase: 2, count: 2 },
    ])
  })

  it('is empty when no component claims a phase — no ladder to draw', () => {
    expect(curatedLadder({ ...ROOT, nodes: [{ id: 'a', kind: 'module', title: 'A', delta: 'stable' }] })).toEqual([])
  })
})

describe('phaseHighlight', () => {
  it('lights the components a phase touches and dims the rest', () => {
    expect(phaseHighlight(ROOT, 1)).toEqual({ lit: ['bff'], dimmed: ['engine', 'db'] })
  })

  it('lights everything when nothing is selected', () => {
    expect(phaseHighlight(ROOT, null).dimmed).toEqual([])
  })

  it('LIGHTS EVERYTHING for a phase that touches nothing, rather than blanking it', () => {
    // "This phase touches none of these" is not "these do not exist", and a
    // diagram with every card dimmed reads as broken.
    expect(phaseHighlight(ROOT, 99).dimmed).toEqual([])
  })

  it('dims, never removes — the layout must not move on a selection', () => {
    const result = phaseHighlight(ROOT, 2)
    expect([...result.lit, ...result.dimmed].sort()).toEqual(['bff', 'db', 'engine'])
  })
})

describe('litWire', () => {
  it('lights a wire only when BOTH ends are lit', () => {
    expect(litWire('bff', 'engine', new Set(['bff', 'engine']))).toBe(true)
    expect(litWire('bff', 'engine', new Set(['bff']))).toBe(false)
  })
})
