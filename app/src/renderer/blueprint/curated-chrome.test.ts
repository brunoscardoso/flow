// Tests for the curated brief chrome.
//
// The load-bearing rule is that A BAND IS NEVER SYNTHESISED. This exact bug
// already shipped once: the brief's problem text fell back to the first story
// step, and a plan PHASE was presented under a heading reading `KNOWN ISSUE`.
// A band is a strong claim in a loud box; taking whatever text is nearest and
// putting it there manufactures the claim.

import { buildCuratedChrome, hasChrome } from './curated-chrome'
import { buildDerivedLevel } from './derived-level'
import type { CuratedLevel, CuratedView } from './curated-view'

const LEVEL: CuratedLevel = {
  title: 'Chat, today',
  kicker: 'Level 0 · how chat actually works',
  summary: 'The browser talks only to the engine through the BFF.',
  nodes: [{ id: 'a', kind: 'module', title: 'A', delta: 'stable' }],
  edges: [],
}

function view(brief: Record<string, unknown> = {}, level: Partial<CuratedLevel> = {}): CuratedView {
  return {
    feature: 'chat-session-cache-rework',
    provenance: 'plan:chat_session_cache_rework_v1',
    generatedAt: '2026-08-04',
    meta: { title: 'Chat Session Cache Rework', sub: 'move chat ownership into the engine' },
    brief,
    views: { root: { ...LEVEL, ...level } },
  }
}

function chrome(brief: Record<string, unknown> = {}, time: 'now' | 'next' = 'now', level: Partial<CuratedLevel> = {}) {
  const v = view(brief, level)
  return buildCuratedChrome(v, v.views['root'], time)
}

describe('buildCuratedChrome — heading', () => {
  it('leads with the artifact title and its one-clause subtitle', () => {
    const result = chrome()
    expect(result.title).toBe('Chat Session Cache Rework')
    expect(result.sub).toBe('move chat ownership into the engine')
    expect(result.kicker).toBe('Level 0 · how chat actually works')
  })

  it('falls back to the level title when the artifact names none', () => {
    const v = view()
    v.meta = { title: '' }
    expect(buildCuratedChrome(v, v.views['root'], 'now').title).toBe('Chat, today')
  })
})

describe('buildCuratedChrome — the summary swaps with time', () => {
  it('shows the After summary once the reader flips, when one was written', () => {
    const result = chrome({}, 'next', { summaryNext: 'The engine owns the conversation.' } as never)
    expect(result.summary).toBe('The engine owns the conversation.')
  })

  it('keeps the one summary in both worlds rather than blanking after a flip', () => {
    expect(chrome({}, 'next').summary).toBe('The browser talks only to the engine through the BFF.')
  })
})

describe('buildCuratedChrome — bands are never synthesised', () => {
  it('renders the KNOWN ISSUE band from the generated problem', () => {
    const result = chrome({ problem: 'One conversation is written three times.' })
    expect(result.band).toEqual({
      tone: 'problem',
      label: 'Known issue',
      text: 'One conversation is written three times.',
    })
  })

  it('renders NO band when the artifact supplies no problem', () => {
    // REGRESSION. The predecessor fell back to the nearest text and put a plan
    // phase under a KNOWN ISSUE heading.
    expect(chrome({ todayHow: [['yes', 'this is not a problem']] }).band).toBeNull()
  })

  it('does not borrow the guarantee to fill the Today band', () => {
    expect(chrome({ unchanged: 'Streaming UX must not regress.' }, 'now').band).toBeNull()
  })

  it('does not borrow the problem to fill the After band', () => {
    expect(chrome({ problem: 'written three times' }, 'next').band).toBeNull()
  })

  it('states the guarantee only in After — Today makes no promise about a change', () => {
    const result = chrome({ unchanged: 'Streaming UX must not regress.' }, 'next')
    expect(result.band).toEqual({
      tone: 'guarantee',
      label: 'Unchanged',
      text: 'Streaming UX must not regress.',
    })
  })

  it('treats whitespace as absent', () => {
    expect(chrome({ problem: '   ' }).band).toBeNull()
  })
})

describe('buildCuratedChrome — slots', () => {
  it('builds a chip per non-empty list, keeping the artifact tone words', () => {
    const result = chrome({
      todayHow: [['yes', 'Browser POSTs /api/chat/stream.']],
      todayProblems: [['bad', 'One turn is persisted three times.']],
    })
    expect(result.slots.map((slot) => slot.id)).toEqual(['todayHow', 'todayProblems'])
    expect(result.slots[0].items[0]).toEqual({ tone: 'yes', text: 'Browser POSTs /api/chat/stream.' })
    expect(result.slots[1].label).toBe('Known problems')
  })

  it('omits a slot with nothing in it rather than showing an empty list', () => {
    expect(chrome({ todayHow: [] }).slots).toEqual([])
  })

  it('drops an item with no text', () => {
    expect(chrome({ todayHow: [['yes', '  '], ['yes', 'real']] }).slots[0].items).toHaveLength(1)
  })

  it('names the honesty slot for what it holds', () => {
    const result = chrome({ fails: [['bad', 'Nothing proves the sweeper runs.']] })
    expect(result.slots[0].label).toBe('Claims nothing can prove')
  })
})

describe('buildCuratedChrome — the authored-claims count', () => {
  it('counts the guarantee and every unprovable claim', () => {
    // No extractor produces these, so the ledger must say so rather than let
    // the format's authority launder them into derived facts.
    const result = chrome({
      unchanged: 'Streaming UX must not regress.',
      fails: [['bad', 'a'], ['bad', 'b']],
      todayHow: [['yes', 'derived enough']],
    })
    expect(result.authoredClaims).toBe(3)
  })

  it('counts nothing when the artifact claims nothing', () => {
    expect(chrome().authoredClaims).toBe(0)
  })
})

describe('hasChrome', () => {
  it('is false for an artifact with no chrome at all', () => {
    const bare: CuratedView = {
      feature: 'f',
      provenance: 'code',
      generatedAt: 'd',
      meta: { title: 'T' },
      views: { root: { title: 'T', nodes: [], edges: [] } },
    }
    expect(hasChrome(buildCuratedChrome(bare, bare.views['root'], 'now'))).toBe(false)
  })

  it('is true as soon as there is one thing to say', () => {
    expect(hasChrome(chrome())).toBe(true)
  })
})

// ── Phase 6.4: the DERIVED level renders through this chrome ─────────────────
//
// The derived level (`derived-level.ts`) is artifact-SHAPED precisely so it can
// be drawn by this module and the rest of the curated pipeline with no changes
// at all. What it must never do is borrow the problem band to announce itself:
// "this was derived from the code map" is not a known issue, and putting it in
// a box headed KNOWN ISSUE manufactures exactly the claim the never-synthesise
// rule exists to stop. So its announcement rides in the kicker and the summary,
// which this module reads straight off the artifact.

describe('buildCuratedChrome — a derived level announces itself without a band', () => {
  const derived = buildDerivedLevel(
    { id: 'feature:chats', name: 'Chats' },
    {
      components: [{ id: 'module:a', label: 'A' }, { id: 'module:b', label: 'B' }],
      edges: [
        { source: 'module:a', target: 'module:b', relation: 'imports' },
        { source: 'module:a', target: 'module:b', relation: 'calls' },
      ],
    },
  )
  const derivedChrome = () => {
    const v = derived?.view as CuratedView
    return buildCuratedChrome(v, v.views['root'], 'now')
  }

  it('renders NO band at all — the derived notice is not a known issue', () => {
    expect(derivedChrome().band).toBeNull()
  })

  it('renders no band after a time flip either', () => {
    const v = derived?.view as CuratedView
    expect(buildCuratedChrome(v, v.views['root'], 'next').band).toBeNull()
  })

  it('carries the derived announcement in the kicker, where it is not a claim', () => {
    expect(derivedChrome().kicker).toContain('Derived')
    expect(derivedChrome().kicker).toContain('not a curated view')
  })

  it('carries the notice — and any hidden count — in the summary', () => {
    const summary = derivedChrome().summary ?? ''
    expect(summary).toContain('Derived from the code map')
    expect(summary).toContain('not what the feature does')
    expect(summary).toContain('nothing here was validated')
  })

  it('says out loud what a cap hid, in the same summary', () => {
    // NO SILENT TRUNCATION. The cap's cut reaches the chrome the reader meets.
    const capped = buildDerivedLevel(
      { id: 'feature:chats', name: 'Chats' },
      {
        components: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [
          { source: 'a', target: 'b', relation: 'imports' },
          { source: 'a', target: 'c', relation: 'imports' },
        ],
        cap: 1,
      },
    )
    const v = capped?.view as CuratedView
    const summary = buildCuratedChrome(v, v.views['root'], 'now').summary ?? ''
    expect(summary).toContain('1 weaker connection hidden')
    expect(summary).toContain('1 of 2 shown')
  })

  it('counts NO authored claims — nothing here was authored by anyone', () => {
    expect(derivedChrome().authoredClaims).toBe(0)
    expect(derivedChrome().slots).toEqual([])
  })

  it('still has chrome worth drawing', () => {
    expect(hasChrome(derivedChrome())).toBe(true)
  })
})
