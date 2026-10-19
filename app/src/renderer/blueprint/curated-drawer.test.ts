// Tests for the curated component drawer.
//
// Two properties carry the weight. TODAY WITHHOLDS THE PLAN — the pre-plan
// world must not leak the change into itself. And A REFERENCE IS A CLAIM until
// something checks it: the section is titled "verified", so an unchecked entry
// must say so rather than borrow the heading's authority.

import { buildCuratedDrawer, codeProvenance, DRAWER_NOTHING_RECORDED } from './curated-drawer'
import type { CuratedNode } from './curated-view'

const CODE = {
  file: 'src/chat/stream.ts',
  from: 851,
  to: 857,
  note: 'This is where the tee happens.',
  text: 'const x = 1',
}

function node(patch: Partial<CuratedNode> = {}): CuratedNode {
  return {
    id: 'bff',
    kind: 'endpoint',
    title: 'Gateway BFF',
    delta: 'modify',
    doc: 'The browser-facing proxy.',
    now: 'Tees the SSE stream into Prisma.',
    next: 'Relays only; the engine writes.',
    ...patch,
  }
}

describe('buildCuratedDrawer — sections', () => {
  it('leads with what the component is', () => {
    const drawer = buildCuratedDrawer(node())
    expect(drawer.sections[0]).toEqual({ label: 'What it is', text: 'The browser-facing proxy.' })
  })

  it('WITHHOLDS the After section in Today', () => {
    const drawer = buildCuratedDrawer(node(), { time: 'now' })
    expect(drawer.sections.map((section) => section.label)).not.toContain('After')
  })

  it('shows After once the reader has flipped to it', () => {
    const drawer = buildCuratedDrawer(node(), { time: 'next' })
    expect(drawer.sections.map((section) => section.label)).toContain('After')
  })

  it('never renders an empty section', () => {
    const drawer = buildCuratedDrawer({ id: 'x', kind: 'module', title: 'X', delta: 'stable' })
    expect(drawer.sections).toEqual([])
  })

  it('carries the excerpt note as its own section', () => {
    const drawer = buildCuratedDrawer(node({ code: CODE }))
    expect(drawer.sections.map((section) => section.label)).toContain('Why this code matters')
  })
})

describe('buildCuratedDrawer — heading', () => {
  it('splits a run-on headline the same way the card does', () => {
    const drawer = buildCuratedDrawer(node({ title: 'Gateway BFF · streamTurn' }))
    expect(drawer.title).toBe('Gateway BFF')
    expect(drawer.sub).toBe('streamTurn')
  })

  it('tags a changing component with its delta, a stable one with its kind', () => {
    expect(buildCuratedDrawer(node()).tag).toBe('modify')
    expect(buildCuratedDrawer(node({ delta: 'stable' })).tag).toBe('endpoint')
  })
})

describe('buildCuratedDrawer — references are claims until checked', () => {
  const withRefs = node({
    refs: [
      ['src/chat/stream.ts', 'the tee'],
      ['src/ghost/nowhere.ts', 'not a thing'],
    ],
  })

  it('marks a reference resolved only when the brief resolved it', () => {
    const drawer = buildCuratedDrawer(withRefs, {
      anchors: new Map([['file:src/chat/stream.ts', true]]),
    })
    expect(drawer.refs[0].resolved).toBe(true)
    expect(drawer.refs[1].resolved).toBe(false)
  })

  it('KEEPS an unresolved reference rather than dropping it', () => {
    // Dropping would leave a section titled "verified" whose contents were
    // selected by what happened to be checkable.
    const drawer = buildCuratedDrawer(withRefs, { anchors: new Map() })
    expect(drawer.refs).toHaveLength(2)
    expect(drawer.refs.every((ref) => !ref.resolved)).toBe(true)
  })

  it('does not treat an UNRESOLVED anchor as confirmation', () => {
    const drawer = buildCuratedDrawer(withRefs, {
      anchors: new Map([['file:src/chat/stream.ts', false]]),
    })
    expect(drawer.refs[0].resolved).toBe(false)
  })

  it('sees through decoration and anchor prefixes', () => {
    const drawer = buildCuratedDrawer(node({ refs: [['`src/chat/stream.ts`', 'x']] }), {
      anchors: new Map([['file:src/chat/stream.ts:851', true]]),
    })
    expect(drawer.refs[0].resolved).toBe(true)
  })

  it('resolves nothing when the brief supplied no anchors at all', () => {
    expect(buildCuratedDrawer(withRefs).refs.every((ref) => !ref.resolved)).toBe(true)
  })
})

describe('buildCuratedDrawer — actions', () => {
  it('offers the excerpt file for opening', () => {
    expect(buildCuratedDrawer(node({ code: CODE })).openFile).toBe('src/chat/stream.ts')
  })

  it('REFUSES to render a discovery document inside the CODE BOX', () => {
    // Seen live: an artifact generated before the rule reached the pass showed
    // `discovery_chat_session_cache_rework_v2.md:129` in a code box. The lines are
    // real; a code box rendering prose still presents an argument as an
    // implementation. The note survives — that is where the text belonged.
    const doc = buildCuratedDrawer(
      node({ code: { ...CODE, file: 'flow/discovery/x_v2.md' } }),
    )
    expect(doc.code).toBeNull()
    expect(doc.sections.map((section) => section.label)).toContain('Why this code matters')
  })

  it('REFUSES to open a plan or discovery document as if it were the code', () => {
    // An "open the code" button that opens an argument about the code is the
    // same lie the excerpt rule already refuses, one surface later.
    const doc = buildCuratedDrawer(node({ code: { ...CODE, file: 'flow/discovery/x_v1.md' } }))
    expect(doc.openFile).toBeNull()
  })

  it('carries a drill target only when the artifact declares one', () => {
    expect(buildCuratedDrawer(node()).drillTo).toBeNull()
    expect(buildCuratedDrawer(node({ view: 'bffdetail' })).drillTo).toBe('bffdetail')
  })

  it('carries the rollout phases the component belongs to', () => {
    expect(buildCuratedDrawer(node({ phases: [2, 3] })).phases).toEqual([2, 3])
  })
})

describe('codeProvenance', () => {
  it('states the file and the exact lines the excerpt came from', () => {
    expect(codeProvenance(CODE)).toBe('src/chat/stream.ts:851-857')
  })
})

describe('buildCuratedDrawer — the address is a claim too (#1435)', () => {
  // The CLI's brief-time check stamps non-fresh excerpts with a freshness
  // verdict; the drawer folds three verdicts to two words. Absence of a
  // verdict IS the fresh verdict — the CLI never stamps a fresh excerpt.

  it('says nothing about a fresh excerpt — no freshness field, no caveat', () => {
    expect(buildCuratedDrawer(node({ code: CODE })).codeCaveat).toBeNull()
  })

  it("downgrades 'gone' to its own verdict — nothing at that address to look at", () => {
    const drawer = buildCuratedDrawer(node({ code: { ...CODE, freshness: 'gone' } }))
    expect(drawer.codeCaveat).toBe('gone')
    // The excerpt STAYS, and stays openable: the text is true history,
    // evidence of what the generator read. Only the assertion is downgraded.
    expect(drawer.code).not.toBeNull()
    expect(drawer.openFile).toBe('src/chat/stream.ts')
  })

  it("folds 'shifted' to 'changed' — the reader's next move is to open and look", () => {
    expect(buildCuratedDrawer(node({ code: { ...CODE, freshness: 'shifted' } })).codeCaveat).toBe(
      'changed',
    )
  })

  it("folds 'unknown' to 'changed' too — unverified is not verified", () => {
    expect(buildCuratedDrawer(node({ code: { ...CODE, freshness: 'unknown' } })).codeCaveat).toBe(
      'changed',
    )
  })
})

describe('buildCuratedDrawer — a component that is a learned PART', () => {
  const part = {
    name: 'Gateway BFF',
    summary: 'The browser-facing proxy.',
    anchors: ['src/app/api/chat'],
    learnings: [{ text: 'It tees the SSE into Prisma.', provenance: 'code', date: '2026-08-04' }],
  }

  it('attaches what was learned about THAT piece', () => {
    const drawer = buildCuratedDrawer(node(), { parts: [part] })
    expect(drawer.learned?.learnings[0].text).toBe('It tees the SSE into Prisma.')
  })

  it('matches by name only — loose matching would attach the wrong knowledge', () => {
    const drawer = buildCuratedDrawer(node({ title: 'Gateway BFF proxy' }), { parts: [part] })
    expect(drawer.learned).toBeNull()
  })

  it('is null when the feature has no parts at all', () => {
    expect(buildCuratedDrawer(node()).learned).toBeNull()
  })
})


describe('buildCuratedDrawer — a derived card', () => {
  // A derived card carries only an id, a kind and a title. Measured live: the
  // drawer first opened EMPTY.
  const bare = (): CuratedNode => ({ id: 'integration:assistant-execution', kind: 'integration', title: 'Unified Core assistant execution', delta: 'new' })

  it('never opens blank: with nothing at all to show it says so', () => {
    // Positive first: the same card with something recorded is not empty.
    expect(buildCuratedDrawer({ ...bare(), doc: 'Runs every assistant.' }).emptyNote).toBeNull()
    expect(buildCuratedDrawer(bare()).emptyNote).toBe(DRAWER_NOTHING_RECORDED)
  })

  it('does not add the note to a card that already has content', () => {
    expect(buildCuratedDrawer(node()).emptyNote).toBeNull()
  })
})
