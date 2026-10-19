// Tests for the curated-view model — what a generated level CONTAINS.
//
// Its geometry moved to the territory sheet (`territory-level.ts`) with the
// ring's removal, so what is pinned here is the semantics: the layering a
// cyclic view still resolves to, the headline split, and the delta vocabulary
// a curated level maps onto.

import {
  curatedHasDelta,
  curatedToDelta,
  rootLevel,
  splitHeadline,
  type CuratedLevel,
} from './curated-view'

function level(patch: Partial<CuratedLevel> = {}): CuratedLevel {
  return {
    title: 'Chat persistence',
    nodes: [
      { id: 'browser', kind: 'project', title: 'Browser · Chat UI', delta: 'stable' },
      { id: 'bff', kind: 'endpoint', title: 'Gateway BFF', sub: 'streamTurn', delta: 'modify' },
      { id: 'engine', kind: 'endpoint', title: 'Agent core engine', delta: 'stable' },
    ],
    edges: [
      { from: 'browser', to: 'bff', label: 'send message', delta: 'kept' },
      { from: 'bff', to: 'engine', label: 'forward', delta: 'kept' },
    ],
    ...patch,
  }
}

describe('splitHeadline', () => {
  it('leads with the first segment and details the rest', () => {
    expect(splitHeadline('Gateway BFF · streamTurn · /api/chat/*')).toEqual({
      title: 'Gateway BFF',
      sub: 'streamTurn · /api/chat/*',
    })
  })

  it('keeps a headline that carries no separator exactly as written', () => {
    expect(splitHeadline('Agent core engine')).toEqual({ title: 'Agent core engine', sub: null })
  })

  it('keeps an explicit sub, and appends rather than discards', () => {
    expect(splitHeadline('Prisma · app Postgres', 'Chat · Message')).toEqual({
      title: 'Prisma',
      sub: 'Chat · Message · app Postgres',
    })
  })

  it('never puts a path on the card face', () => {
    expect(splitHeadline('Redis fan-out (app DB4) · pub/sub → /api/chat/events').title).not.toContain('/')
  })
})

describe('curatedToDelta', () => {
  it('maps components onto the delta vocabulary the brief already speaks', () => {
    const delta = curatedToDelta(level())
    expect(delta.nodes).toContainEqual({
      nodeId: 'bff',
      kind: 'modify',
      existsToday: true,
      label: 'Gateway BFF',
    })
  })

  it('marks a NEW component as absent today', () => {
    const delta = curatedToDelta(
      level({ nodes: [{ id: 'm', kind: 'function', title: 'Migrate', delta: 'new' }] }),
    )
    expect(delta.nodes[0].existsToday).toBe(false)
  })

  it('carries both labels of a wire whose meaning changes', () => {
    const delta = curatedToDelta(
      level({
        edges: [
          { from: 'browser', to: 'bff', label: 'write USER', labelNext: 'no write', delta: 'removed' },
        ],
      }),
    )
    expect(delta.wires[0].labelBefore).toBe('write USER')
    expect(delta.wires[0].labelAfter).toBe('no write')
  })

  it('does not draw an ADDED wire today', () => {
    const delta = curatedToDelta(
      level({ edges: [{ from: 'browser', to: 'bff', label: 'copy', delta: 'added' }] }),
    )
    expect(delta.wires[0].drawnToday).toBe(false)
  })
})

describe('curatedHasDelta', () => {
  it('is false when nothing changes — one world needs no switch', () => {
    const stable = level({
      nodes: [{ id: 'a', kind: 'module', title: 'A', delta: 'stable' }],
      edges: [],
    })
    expect(curatedHasDelta(stable)).toBe(false)
  })

  it('is true when any component or connection changes', () => {
    expect(curatedHasDelta(level())).toBe(true)
  })
})

describe('rootLevel', () => {
  it('opens the root level', () => {
    const view = { feature: 'f', provenance: 'p', generatedAt: 'd', meta: { title: 'T' }, views: { root: level() } }
    expect(rootLevel(view)?.title).toBe('Chat persistence')
  })

  it('is null for a missing or empty view — the board keeps its old behaviour', () => {
    expect(rootLevel(null)).toBeNull()
    const empty = {
      feature: 'f',
      provenance: 'p',
      generatedAt: 'd',
      meta: { title: 'T' },
      views: { root: level({ nodes: [], edges: [] }) },
    }
    expect(rootLevel(empty)).toBeNull()
  })
})
